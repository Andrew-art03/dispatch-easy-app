# Consolidate Truck Setup in Settings

## Scope
Make Settings the single destination for both the existing truck profile form and the visual truck appearance controls. Preserve every current field, default, validation rule, save action, and completion calculation.

## Changes
- Extract the existing Truck Profile form into a reusable screen section and place it on `/settings` alongside Truck appearance.
- Change the Board empty-state “Set up my truck” action to `/settings` and remove the duplicate Settings action from that card.
- Point the bottom-nav Truck tab to `/settings`.
- Keep `/truck` as a compatibility redirect to `/settings`, so old links cannot expose a second form.

## Technical details
- Continue reading/writing only the existing `truck` columns and `driver.hos_hours_left` through the current RLS-backed client behavior.
- No schema, endpoint, validation, or collected-data changes.

## Verification
- At 390px, open Board and click “Set up my truck”; confirm `/settings` contains the full profile and appearance controls.
- Return to Board, click the Truck bottom-nav tab, and confirm it lands on the same `/settings` screen.
- Confirm the completion indicator and form fields render, and check build/runtime errors.
