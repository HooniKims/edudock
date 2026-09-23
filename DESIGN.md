# 업무 곁 v2 design system

## 0. Reference and intent

The desktop entry point is the black edge-attached inverse-corner notch from the pinned CodeNotch reference at commit `ec1a7e3fc0634f668741cb0357029420bdd4281c`. The approved product spec replaces the former large silver-white launcher. The supplied `frame-124-hover-tooltip.png`, `SideNotchShape.swift`, `NotchLayout.swift`, and Windows `ui/notch.html` are the concrete shape contract. Six school-work actions and settings replace provider rings. Paperlogy remains the product typeface.

## 1. People and tasks

A teacher must reach a frequent task from the screen edge without covering portal content. The notch stays compact and recognizable on bright or dark wallpapers. Authentication may move focus to Edge or a certificate program; the notch must not steal focus back. Draft writing and settings need normal, readable windows and preserve in-memory input while switching views.

## 2. Material and color

The notch is solid black `#000000`. Primary glyph/text is `#F5F5F7`, secondary state is `#B0B0B8`, and focus/action accent is `#76ACFF`. Success is `#57D89B`, error is `#FF766B`, and user-action-needed is `#FFD166`. The visible body has no border, glass, card fill, or gap at the attached edge. The SVG silhouette supplies antialiased curves; Electron's native shape supplies the matching input region.

Auxiliary draft/settings windows retain the restrained light material already used by the form controls. They are ordinary windows, never always-on-top.

## 3. Type

Paperlogy Regular 400 and SemiBold 600 are bundled locally. Fallback is Malgun Gothic/system sans-serif. Notch labels are accessible names and native title tooltips; visible meaningful text is never below 12 DIP. Auxiliary body text is 14 DIP where space allows. Korean labels use full phrases and must not orphan a final syllable.

## 4. Space and geometry

Base spacing unit is 4 DIP.

| Token | Value |
|---|---:|
| expanded body | 332 x 56 DIP |
| shoulder radius | 31 DIP |
| free-corner radius | 24 DIP |
| expanded maximum extent | 394 x 56 DIP |
| collapsed visual | 79 x 10 DIP |
| collapsed cursor wake zone | 79 x 34 DIP |
| action target | 40 x 40 DIP |
| action gap | 4 DIP |
| body inset | 8 DIP |
| icon | 20 DIP |

The canonical path is authored once against the right edge and transformed to top, right, bottom, or left. The product default is the right edge in a vertical orientation. Top/bottom are horizontal; left/right are vertical. Renderer SVG and native hit rectangles come from the same geometry module. Placement uses display work-area DIP and permits negative monitor coordinates.

Draft opens at 960 x 720 DIP with a 640 x 480 minimum. Settings targets 440 x 560 DIP and scrolls internally. One auxiliary BrowserWindow and one DOM are reused for both views.

## 5. Reusable primitives

### Edge notch

- Structure: antialiased SVG path, native input shape, action rail.
- Variants: top, right, bottom, left; expanded, collapsed, moving, and resizing.
- States: idle, opening, needs-user, success, error, placement preview. `needs-user` shows an explicit **다시 시도** action that replays the one pending work item; a busy operation shows **취소** instead.
- Accessibility: semantic nav, 40 DIP buttons, complete Korean accessible names, visible keyboard focus.
- Layout: one row on top/bottom, one column on left/right; glyphs never rotate.

### Notch action

- Structure: native button with line SVG.
- Variants: portal, NEIS, attendance, trip, general drafting, local draft, settings.
- States: default, hover, active, focus-visible, disabled/pending.
- Motion: color/scale feedback only; reduced motion removes transform.

### Auxiliary view

- Structure: existing draft and settings sections inside one persistent DOM.
- Behavior: main process sends an IPC view change; it never reloads the file to switch roles.
- State: draft field values and generated output survive a settings visit.
- Official-login setting: a native switch labeled **시작할 때 자동 로그인**. It defaults off, applies on the next app start, and never implies that changing the switch authenticated the user.

## 6. Motion and interaction

The notch uses the approved 420 ms response with damping 0.78, 180 ms pointer entry, 250 ms tooltip leave, and 450 ms fold delay. Content reveal is 360 ms and action stagger is 45 ms capped at 180 ms. Spatial motion uses transforms; color/opacity uses short easing. `prefers-reduced-motion` removes transforms and preserves every action and status.

Automatic display uses `showInactive()`. Explicit auxiliary actions may focus the auxiliary window. Authentication and external programs may retain focus.

The automatic mode starts with the 79 x 10 DIP visual and observes a 79 x 34 DIP cursor corridor without adding that corridor to the native input region. Entry waits 180 ms, leave waits 450 ms, and the same canonical shape snapshot drives the renderer path and Windows `setShape()` scanlines throughout the 420 ms transition. A 64 DIP native window minimum is padded only away from the attached edge, so the black visual remains flush and the padding remains click-through. Existing schema-3 `expanded` preferences remain expanded; new profiles default to `auto`.

Clicking empty black body space toggles a temporary pin. The settings display mode offers `자동` and `항상 펼치기`; the persistent mode and temporary pin remain independent. Escape first cancels an active placement preview and restores its exact starting placement, then follows the popup, temporary-pin, and automatic-fold order. Hover tooltips and the status panel are Paperlogy-rendered black inward popovers with a shared pointer/focus corridor. A hover popup uses `showInactive()`, while an explicitly opened status panel may take keyboard focus and returns it to the notch when closed.

The straight body segment provides two subtle placement rails inside the existing 8 DIP action insets. The attached-edge rail moves the notch; the inward rail changes uniform scale. Their visible cue is quiet until hover, keyboard focus, or an active blue placement preview. The rails never overlap the 40 DIP action targets, remain inside the native black shape at 85%, and have complete Korean accessible names. Pointer capture begins synchronously, lost capture or window blur cancels, and pointer release persists once. Movement snaps only inside a 72 DIP destination-edge corridor. Each edge stores an independent relative offset, while horizontal and vertical modes remember the last edge in that orientation.

Resize maps one canonical 100% notch depth (56 DIP) to the complete 85-150% range. This keeps both endpoints reachable from the inset rail center using only cursor coordinates inside the attached display on all four edges.

## 7. Responsive and accessibility

Scale is clamped to 85-150% and further capped when the selected work-area DIP length cannot fit every action. Native shape and SVG use the same scaled snapshot. The active edge remains flush to the selected work-area boundary, including negative coordinates and taskbar-reduced work areas. A removed monitor or resume from sleep recovers to the visible primary display; an old null monitor ID binds to primary without losing its valid edge or offset. Transparent corner pixels are absent from the native input shape so underlying desktop controls receive clicks. Windows `BrowserWindow.setShape()` remains the authoritative input region; cursor polling is limited to the invisible collapsed wake corridor and non-Windows/native-shape fallback. Focus indication uses a 2 DIP blue inset outline. Status is announced through a polite live region and is never inferred from a click.

## 8. Verification and accepted debt

Stage 2 requires real Windows screenshots for all four edges on controlled light/dark desktop fixtures, bounds proving a 0 DIP attachment gap, and a native click-through target under a transparent corner. Geometry tests alone do not pass the stage.

Accepted debt: Electron `BrowserWindow.setShape()` is experimental. Windows runtime evidence is required on every Electron upgrade. No full-screen transparent overlay is permitted. Any future fallback must remain bounded to the small notch window and preserve click-through transparent corners and the invisible wake corridor.
