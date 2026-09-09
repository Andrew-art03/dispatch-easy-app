# Marker Light visual alignment

## Scope
Apply the founder’s sampled Marker Light palette globally, then strengthen visual hierarchy and semantic status colors without changing layouts, data, routes, or behavior.

## Changes
- Replace shared background, card, text, success, caution, danger, and supporting surface tokens with the exact sampled colors.
- Preserve the Load Card’s strong money hierarchy while changing its status chips to outlined green, amber, and red treatments where needed.
- Strengthen Home’s weekly-goal heading and money display; give Board, Hunt, and Hours status rows outlined semantic borders based on their live states.
- Audit Settings/Truck, Hunt, Docs, and Week $ so green consistently means good or confirmed, amber means caution or unverified, and red means blocking or error.
- Keep the chosen truck-glow color limited to truck underglow, active navigation, selected appearance ring, and goal-meter line/dots.

## Technical details
- Define all palette values once in `src/styles.css` as exact OKLCH conversions of the supplied hex colors.
- Reuse semantic Tailwind tokens in screen code; do not add hard-coded colors or change business logic.
- Keep existing RLS-backed queries, writes, validation, navigation, and frozen schema untouched.

## Verification
- Check the affected screens at 390px for contrast, hierarchy, and consistent status meaning.
- Confirm the Load Card remains the visual benchmark and no status uses the wrong semantic color.
- Check browser errors and the automated build result.
