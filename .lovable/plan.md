# Week $ Founder-Spec Polish

## Scope
Update only the Week $ experience and the existing app cold-open overlay. Keep all figures and interactions front-end-only, preserve the chrome truck asset and persisted glow color, and make no backend, schema, API, navigation, or other-tab changes.

## Build
- Replace the cold-open sequence with a session-gated animation: the truck approaches from the center for about 1.2 seconds, veers left onto a compact weekly chart, then advances to the current earned position before the overlay fades. Reduced-motion users skip the overlay and see the settled app state immediately.
- Replace the Week $ horizontal bar with a custom seven-day rising chart using the requested Mon–Fri earnings and dim Sat/Sun placeholders. Show day labels, per-day amounts, a $6,000 goal line, amber earned fill, dark future track, tabular numbers, and the chrome truck at the latest earned point.
- Add the “Simulate delivery +$800” demo control. On the first transition from below target to at/above target, run a lightweight canvas confetti burst above the chart and reveal the exact success card.
- Persist celebration completion in local storage using the current week label/key so it fires once for that week. Show the Easy recommendation card below the success card until either “Raise to $6,500” or “Keep $6,000” is chosen; update the in-memory mock target and dismiss the recommendation.
- Keep the existing run list and Money link below the redesigned goal card unchanged.

## Technical Details
- Add a reusable weekly chart component alongside the existing goal progress components so the cold-open and Week $ screen share chart geometry and truck positioning without changing Board’s current compact bar.
- Use semantic design tokens for chart surfaces and labels; only the existing persisted color value is passed to the truck’s CSS drop-shadow, leaving the image itself untouched.
- Implement confetti with a small local canvas component and `requestAnimationFrame`; add no package.
- Keep the current `ez-intro-played` session flag behavior and use a week-scoped key such as `ez-goal-celebrated:<weekLabel>` for the celebration.

## Verification
- Check the Week $ screen at 390px and desktop widths for readable labels, stable chart sizing, correct truck placement, and no overlaps.
- Verify the simulation crosses the goal once, shows confetti and both cards, each decision dismisses the prompt, and refresh does not replay that week’s celebration.
- Verify a fresh browser session plays the new cold-open once, tab navigation does not replay it, reduced motion skips it, and the saved glow color remains shared.
- Confirm the app build remains healthy and no other tab changed.
