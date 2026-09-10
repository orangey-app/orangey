/**
 * The shape of animation settings, shared by the file format and the UI.
 *
 * Lives in the model rather than the UI because a randomizer file may carry
 * an override for its own type's section, and the model must never import
 * from the UI. The behaviour — defaults, clamping, merging — is in
 * src/ui/feel.ts.
 */

export type MotionLevel = "full" | "quick" | "instant";
export type DiceStyle = "flat" | "wireframe";
export type SpinCurve = "gentle" | "standard" | "snappy";

export interface WheelFeel {
  durationMs: number;
  turns: number;
  curve: SpinCurve;
  /**
   * The most the wheel swings past its target before settling back, in
   * degrees. Each spin uses a random fraction of it — between half and all —
   * so no two landings look alike. 0 switches the roll-back off.
   */
  settleDegrees: number;
}

export interface DiceFeel {
  /** "flat" is the plain numbered square; "wireframe" is the 3D solid. */
  style: DiceStyle;
  tumbleMs: number;
  bounces: number;
  /** How far the dice scatter across the tray before landing, 0..1. */
  spread: number;
}

export interface CoinFeel {
  flips: number;
  durationMs: number;
  /** How high the coin is tossed, as a fraction of its size. 0 flips in place. */
  arc: number;
}

export type MascotPresence = "hidden" | "triggers" | "always";

export interface MascotFeel {
  /**
   * The GM's choice: never shown; shown only when something happens (a roll,
   * a max, a min, a failed link) and gone again afterwards; or always there,
   * idling between rolls.
   */
  presence: MascotPresence;
  /** How much the body wobbles: 0 none, 1 soft, 1.8 the drawn maximum. */
  wobble: number;
  /** Reactions switched off, by id. Absent means on. */
  rules: Record<string, boolean>;
}

export interface FeelSettings {
  motion: MotionLevel;
  wheel: WheelFeel;
  dice: DiceFeel;
  coin: CoinFeel;
  haptics: boolean;
  mascot: MascotFeel;
}

/** What a randomizer's file may override: only the sections, only in part. */
export interface FeelOverride {
  wheel?: Partial<WheelFeel>;
  dice?: Partial<DiceFeel>;
  coin?: Partial<CoinFeel>;
}
