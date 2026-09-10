# F-40 Marker Light treatment pass

## Scope
Apply one consistent typography, shape, spacing, and action-hierarchy treatment across Home, Board, Hunt, Load Card, Docs, Ledger, and Settings. Preserve every existing color, data flow, route, and behavior.

## Changes
- Standardize display text on Barlow Condensed 700, body copy on Barlow, and small uppercase labels on tracked JetBrains Mono.
- Normalize the requested type scale: 96px hero figures, 36px section headings, 20px card titles, and 10.5px labels where those roles appear.
- Replace oversized card and chip rounding with 2–6px instrument-panel corners and subtle 1px hairlines; retain stronger borders only for genuinely active or highlighted states.
- Convert state and fit badges from filled pills to bordered outlines.
- Clarify one primary action per screen, cap primary controls at 56px, and keep at least 16px clear space around commit actions.
- Align section content left and normalize major gaps and padding to the 8px spacing rhythm.
- Make bottom navigation labels small, uppercase, tracked mono utility signage while keeping them centered under icons.

## Technical details
- Add reusable treatment utilities and shared control sizing in `src/styles.css`, then apply semantic classes in the requested routes and their existing shared screen components.
- Do not modify color variables, introduce new components, change the frozen schema, or alter queries and mutations.
- Leave already-compliant body typography, left alignment, and action behavior untouched.

## Verification
- Inspect every requested screen at 390px and a wider desktop viewport for clipping, hierarchy, spacing, and action isolation.
- Confirm cards and chips use the sharper treatment and that existing colors remain unchanged.
- Check browser errors and the automated build result.
