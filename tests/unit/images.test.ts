import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { LibraryService } from "../../src/storage/library.ts";
import { MemoryBackend } from "../../src/storage/memory.ts";
import {
  deleteImage,
  imageBytes,
  imageDataUrl,
  imageUrl,
  imageUrlSync,
  pruneImages,
  putImage,
  putImageData,
  restoreImage,
  useImageStore,
} from "../../src/storage/images.ts";
import { absorbImages, portableRandomizer } from "../../src/ui/storage-actions.ts";
import { decodeRandomizer, encodeRandomizer } from "../../src/model/link.ts";
import { emptyRandomizer, makeItem, type ListRandomizer } from "../../src/model/randomizer.ts";

/**
 * A picture, as far as the store is concerned: a PNG header and some bytes
 * that are not text. The 0xff matters — it is not valid UTF-8, so anything
 * that took this through a decoder and back would hand back something else.
 */
const picture = (tail: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0x7f, tail]);

/** Each test gets its own library, and the store follows it. */
function openStore(): MemoryBackend {
  const backend = new MemoryBackend();
  useImageStore(backend);
  return backend;
}

describe("the image store", () => {
  test("keeps a picture, hands it back three ways, and forgets it when told", async () => {
    const backend = openStore();
    const bytes = picture(1);
    const id = await putImage(bytes);

    assert.deepEqual(await imageBytes(id), bytes);
    assert.deepEqual(await backend.readBytes(`images/${id}.png`), bytes, "the file is where the archive expects it");
    assert.equal(await imageBytes("not-a-picture"), null);

    // Inline, for a file that has to carry the picture with it.
    const inline = (await imageDataUrl(id))!;
    assert.match(inline, /^data:image\/png;base64,/);
    const second = await putImageData(inline);
    assert.notEqual(second, id, "an inline picture arrives as a new one");
    assert.deepEqual(await imageBytes(second), bytes);

    await deleteImage(id);
    assert.equal(await imageBytes(id), null);

    // A sweep keeps what the library still points at, whoever put it there.
    const third = await putImage(picture(3));
    assert.equal(await pruneImages(new Set([second])), 1, "the unreferenced one goes");
    assert.deepEqual(await imageBytes(second), bytes);
    assert.equal(await imageBytes(third), null);
  });

  test("makes one URL per picture, however often a spinning wheel asks", async () => {
    const store = openStore();
    const id = await putImage(picture(2));

    // A synchronous render gets nothing until the picture is loaded, which is
    // why it draws without one rather than waiting.
    assert.equal(imageUrlSync(id), null);
    const [first, second] = await Promise.all([imageUrl(id), imageUrl(id)]);
    assert.equal(first, second, "two asks at once are one URL");
    assert.equal(await imageUrl(id), first, "and so is the next frame");
    assert.equal(imageUrlSync(id), first, "now the render has it");

    await deleteImage(id);
    assert.equal(imageUrlSync(id), null, "and the URL goes with the picture");

    // An outcome can outlive its picture. A wheel asks on every frame, so a
    // miss has to be remembered, or the wheel reads the backend for ever.
    let reads = 0;
    const readBytes = store.readBytes.bind(store);
    store.readBytes = async (p) => {
      reads++;
      return readBytes(p);
    };
    const missing = "no-such-picture";
    assert.equal(await imageUrl(missing), null);
    assert.equal(await imageUrl(missing), null);
    assert.equal(reads, 1, `${reads} reads for a picture that is not there`);

    // Putting it back heals it: a wheel drawn after an import must show it.
    await restoreImage(missing, picture(5));
    assert.ok(await imageUrl(missing), "the store still says it is missing");
  });

  test("keeps its folder out of the library", async () => {
    const backend = openStore();
    await putImage(picture(4));
    await backend.mkdir("Art/images");
    const library = new LibraryService(backend, 20);
    await library.refresh();

    assert.deepEqual(library.files(), [], "a picture is not a randomizer");
    assert.deepEqual(library.folders().map((f) => f.path), ["", "Art", "Art/images"],
      "the store's folder is hidden; a folder of the user's own called images is not");
    assert.equal(library.find("images"), null);
  });
});

describe("a picture travelling", () => {
  const wheel = async (): Promise<ListRandomizer> => ({
    ...(emptyRandomizer("list", "Monsters") as ListRandomizer),
    items: [
      makeItem("Goblin", 3, { image: await putImage(picture(5)), description: "Small" }),
      makeItem("Nothing", 1),
    ],
  });

  test("goes out inside a single file and comes back into the store", async () => {
    openStore();
    const before = await wheel();
    const storedId = before.items[0].image!;

    const portable = (await portableRandomizer(before)) as ListRandomizer;
    assert.equal(portable.items[0].image, undefined, "the id means nothing to anyone else");
    assert.match(portable.items[0].imageData!, /^data:image\/png;base64,/);
    assert.equal(portable.items[1].imageData, undefined, "an outcome with no picture gains nothing");

    // The picture is still the same picture on the way back in, under an id of
    // this library's own.
    const after = (await absorbImages(portable)) as ListRandomizer;
    assert.equal(after.items[0].imageData, undefined);
    assert.deepEqual(await imageBytes(after.items[0].image!), await imageBytes(storedId));
    assert.deepEqual(
      after.items.map((i) => ({ ...i, image: undefined })),
      before.items.map((i) => ({ ...i, image: undefined })),
      "everything else about the wheel is untouched",
    );
  });

  test("never travels in a link", async () => {
    openStore();
    const before = await wheel();
    before.items[1] = { ...before.items[1], imageData: `data:image/png;base64,${btoa("not a real picture")}` };

    const payload = await encodeRandomizer(before);
    const after = (await decodeRandomizer(payload)) as ListRandomizer;
    for (const item of after.items) {
      assert.equal(item.image, undefined, "a link carries no picture id");
      assert.equal(item.imageData, undefined, "and no picture either");
    }
    assert.deepEqual(after.items.map((i) => i.label), ["Goblin", "Nothing"], "the wheel itself still arrives");
  });
});
