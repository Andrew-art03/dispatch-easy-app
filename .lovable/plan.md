# Add Two Truck Appearance Options

## Scope
Expand only the existing visual Truck appearance picker. Keep its layout, selected styling, glow-color behavior, navigation, and all data behavior unchanged.

## Build
- Add a Lowboy tile showing the existing heavy-duty tractor style with a clearly lowered drop-deck trailer.
- Add a Gooseneck Trailer tile showing the existing dually-pickup style towing a separate bed-mounted gooseneck flatbed.
- Match the existing studio-photo treatment, dark tile background, labels, and amber selected outline.
- Keep selection local and visual-only; make no schema, API, route, or truck-profile changes.

## Verification
- Open Settings at a 390px viewport and confirm both tiles render in the grid without clipping.
- Select each new tile and confirm the same selected-state treatment appears.
- Confirm the preview reports no runtime or build errors.
