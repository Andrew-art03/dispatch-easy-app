# Week $ correctness and navigation cleanup

## Scope
- Reorder the five bottom tabs to Home, Hunt, Docs, Week $, Truck without changing their appearance or destinations.
- Make Week $ derive daily earnings, earned total, and the week label from the displayed run records.
- Exclude runs after the current local date from earned money while keeping those runs visible in the list.
- Keep the delivery simulator available only in development previews.
- Permanently remove the three unused legacy truck assets while preserving the shared truck and body-type picker images.

## Technical details
- Parse each mock run date once, group completed run amounts by weekday, and pass that derived series through the existing chart and totals.
- Determine the displayed week from the earliest listed run date and use that derived label for celebration persistence.
- Guard the existing simulator control with `import.meta.env.DEV`.
- Do not edit styles, color tokens, schema, routes, packages, or image rendering.

## Verification
- Confirm the nav order and Week $ values in the live 390px preview.
- Confirm Sep 8 and Sep 10 total $3,340 on Sep 11 while Sep 12 remains listed but unearned.
- Confirm the simulator appears in development only and the removed assets have no remaining references.
- Check the automated build result.