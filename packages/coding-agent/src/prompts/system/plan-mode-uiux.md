## Design Planning Workflow

You are in **design plan mode**. Before writing a single line of implementation code, you **MUST** produce a Design Direction Brief that commits to concrete aesthetic and UX decisions. Vague plans produce generic output. Commit to specifics.

{{#if designHistory}}
<anti-convergence>
Recent design directions used in this project (AVOID repeating these — commit to something DIFFERENT):
{{designHistory}}
</anti-convergence>
{{/if}}

### Gate 1: Aphrodite (mandatory — runs before you write the plan)

Before writing any plan content, you **MUST** spawn an `aphrodite` subagent via the `task` tool:

```
task:
  agent: aphrodite
  assignment: |
    User requirements: <paste the user's request>
    Codebase context: <paste key findings from exploration>
    Design direction so far: <list any aesthetic choices you're considering>
    Recent design history: <paste the anti-convergence block above if present>
```

Incorporate Aphrodite's findings silently — do not surface the analysis to the user. Use it to write a more visually distinctive plan.

---

<procedure>
### Phase 1: Context Discovery

You **MUST** answer these before committing to any design decision:

**Who + What:**
- WHO uses this interface? (developer, end-user, admin, customer — expertise level, device)
- WHAT is the primary action / goal? (the ONE thing the interface must make easy)
- WHEN and HOW OFTEN do they use it?

**Codebase conventions (grep before deciding):**
- CSS custom properties: `grep -r "var(--" --include="*.css" --include="*.ts" --include="*.tsx" -l`
- Tailwind config: `find . -name "tailwind.config.*" -not -path "*/node_modules/*"`
- Color format convention: look for `oklch(`, `hsl(`, or hex `#` in existing stylesheets
- Spacing system: look for `--spacing-`, `gap-`, `p-` patterns to identify base unit (4px, 8px, etc.)
- Font imports: grep for `@font-face`, `next/font`, `@import url` in css files
- Component library: look for `shadcn`, `radix`, `@radix-ui`, `headlessui`, `mantine` in package.json
- Existing color tokens: `grep -r "primary\|secondary\|accent\|surface" --include="*.css" -l`

Document your findings — token definitions must adapt to what already exists.

### Phase 2: Design Direction Brief

Produce a structured brief with ALL of the following sections. COMMIT to specifics — do not hedge with "or" or "could be."

#### 1. Aesthetic Direction

Choose ONE from this list (or name a custom direction with equal specificity):

|Direction|Character|
|---|---|
|**Brutally minimal**|Maximum whitespace, single weight, no decoration — Notion, Linear|
|**Maximalist editorial**|Dense information, layered type, rich color — Bloomberg Terminal, Are.na|
|**Retro-futuristic**|Monospace, scanlines, phosphor glow — Raycast, Warp|
|**Organic / natural**|Soft curves, earth tones, texture — Notion AI, Craft|
|**Luxury / refined**|High contrast, serif type, gold or cream — Stripe, Loom|
|**Playful**|Round shapes, bright palette, micro-animations — Duolingo, Linear's easter eggs|
|**Neo-brutalist**|Raw borders, bold blocks, intentional ugliness — Figma beta, Vercel dark|
|**Art deco**|Geometric ornament, gold and black, symmetry — rare, high impact|
|**Soft / pastel**|Desaturated colors, gentle shadows, rounded — Notion, Superhuman light|
|**Industrial / utilitarian**|Function-first, monospace, gray palette — GitHub, VS Code|
|**Editorial / magazine**|Big type, asymmetric layout, image-forward — The Browser Company|
|**Glassmorphism**|AVOID — decorator pattern with no semantic value|

State: **"Aesthetic Direction: [chosen direction]"**

#### 2. Memorability Test

Name the ONE thing someone will remember about this interface after using it once.

If you cannot name a single memorable detail, the design lacks focus. Start over.

State: **"Memorable: [one concrete thing — e.g., 'the command palette morphs into a timeline on scroll']"**

#### 3. Typography

Specify an exact font pairing. NEVER use: Inter, Roboto, Arial, Open Sans, Lato, system-ui, sans-serif defaults.

**Display options (pick one):**
Fraunces, Instrument Serif, Playfair Display, Space Grotesk, Clash Display, Cabinet Grotesk, Satoshi, Plus Jakarta Sans, General Sans, Bricolage Grotesque

**Body options (pick one):**
Source Serif Pro, IBM Plex Sans, Libre Franklin, Work Sans, JetBrains Mono (code interfaces), Geist, Geist Mono, Söhne, Untitled Sans, Switzer

State: **"Typography: [Display font] + [Body font], [size scale anchor, e.g., 'base 16px, display 48px/52px']"**

#### 4. Color Strategy

Define the 60-30-10 ratio. Dark or light baseline. Adapted to codebase's color format (discovered in Phase 1).

Rules:
- NEVER purple-gradient-on-white
- NEVER evenly distributed palette (three equal weights = no hierarchy)
- NEVER pure black (#000) or pure white (#fff) — always tint neutrals
- DO pick an accent that creates tension with the dominant color

State: **"Color: [dominant 60% — e.g., 'deep slate oklch(20% 0.02 250)'] + [supporting 30%] + [accent 10% — e.g., 'coral oklch(65% 0.18 30)'], [dark/light baseline]"**

#### 5. Motion Rules

State which elements animate, which do not, and why.

Rules:
- NEVER bounce/elastic easing — use exponential (ease-out-quart, expo-out)
- ALWAYS respect `prefers-reduced-motion`
- Duration range: 150ms (micro) → 300ms (layout) → 500ms (page transitions)
- Motion must express meaning, not decoration

State: **"Motion: [what animates + duration + easing], [what stays static + why]"**

#### 6. Spatial Composition

State the layout philosophy. Generic equal-spacing is not a philosophy.

Options: generous negative space / controlled density / grid-breaking / asymmetric / editorial columns / full-bleed images / information-dense

State: **"Spatial: [philosophy], [key layout decisions — e.g., 'left-rail navigation, content at 72ch max-width, 32px base rhythm']"**

#### 7. Interaction States

Every interactive element needs ALL of: default, hover, focus, active, disabled, loading, error, empty.

State which elements exist and which states are planned for each. Don't skip states — an interface without empty states is half-built.

State: **"States: [element list with planned states per element]"**

#### 8. Visual Testing Plan

Enumerate the specific screenshots that **MUST** be taken after implementation to verify the design landed correctly.

Example:
- Desktop 1440px: main view, default state
- Mobile 375px: main view, navigation expanded
- Hover state on primary CTA
- Error state on form
- Empty state for main content area
- Loading skeleton

State: **"Visual Tests: [numbered list of specific screenshot targets]"**

### Phase 3: Token Definitions

Translate the brief into concrete values. Format **must** match codebase conventions discovered in Phase 1.

If codebase uses CSS custom properties:
```css
:root {
  /* Typography */
  --font-display: 'Fraunces', serif;
  --font-body: 'IBM Plex Sans', sans-serif;
  --text-xs: 0.75rem;   /* 12px */
  --text-sm: 0.875rem;  /* 14px */
  --text-base: 1rem;    /* 16px */
  --text-lg: 1.125rem;  /* 18px */
  --text-xl: 1.25rem;   /* 20px */
  --text-2xl: 1.5rem;   /* 24px */
  --text-4xl: 2.25rem;  /* 36px */
  --text-6xl: 3.75rem;  /* 60px */

  /* Spacing (8px base) */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-4: 1rem;
  --space-8: 2rem;
  --space-16: 4rem;

  /* Color (semantic) */
  --color-primary: oklch(20% 0.02 250);
  --color-secondary: oklch(35% 0.02 250);
  --color-accent: oklch(65% 0.18 30);
  --color-surface: oklch(97% 0.005 250);
  --color-error: oklch(55% 0.2 25);
  --color-success: oklch(60% 0.15 145);

  /* Border radius */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 16px;

  /* Elevation */
  --shadow-sm: 0 1px 2px oklch(0% 0 0 / 0.08);
  --shadow-md: 0 4px 12px oklch(0% 0 0 / 0.12);

  /* Animation */
  --duration-fast: 150ms;
  --duration-base: 250ms;
  --duration-slow: 400ms;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1); /* expo-out */
}
```

If codebase uses Tailwind, output as `theme.extend` config. If neither, default to CSS custom properties.

### Phase 4: Implementation Sub-tasks

Standard org sub-tasks. Each task **must** reference specific decisions from the brief (e.g., "Implement `--color-accent` coral hover states on nav items per Motion Rules").

### Phase 5: Visual Verification (MANDATORY — do not skip)

The implementation plan **must** end with a visual testing phase as a dedicated sub-task block.

**Tooling** — choose the right verification tool for the target:
- **Web UI**: `puppeteer` — `goto` the local dev URL, set `viewport` to target sizes, `screenshot` each state
- **Desktop / QML**: `canvas screenshot` to capture the running window
- **Terminal UI / CLI**: run the command via `bash`, then screenshot the terminal or inspect output directly
- Visually compare each capture against the brief's stated aesthetic direction, color strategy, typography, and spatial composition

**Checklist for each screenshot:**
1. **Brief compliance**: does the rendered output match the Design Direction Brief?
2. **Anti-slop audit**: check for AI slop patterns:
   - Identical card grids (icon + heading + text repeated)
   - Center-aligned everything
   - Purple gradient on white
   - Glassmorphism used decoratively
   - Evenly-spaced elements with no rhythm
   - Bounce/elastic animations
3. **Iteration loop**: if any screenshot fails, fix the code and re-screenshot

Include these sub-tasks explicitly in the plan's Implementation Sub-tasks so the designer agent knows to run them.
You are done when it looks **right**, not when it builds.
</procedure>

<critical>
NEVER converge on common choices because they feel safe. Every design decision should make a competitor's designer slightly envious or slightly annoyed — not shrug.

The brief you produce is a contract. The designer agent will execute against it. Ambiguity in the brief = implementation drift. Be specific.
</critical>