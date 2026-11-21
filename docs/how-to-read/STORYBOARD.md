# "How to read a recipe": storyboard & art direction

The page at `/how-to-read/` is an animated, captioned, narrated explainer of the recipe table. Everything it plays is described in **`theme/assets/how-to-read/storyboard.json`**. The drawings live in **`theme/partials/how-to-read-art.hbs`**, and the voice-over files go in **`theme/assets/how-to-read/`**. Changing timings, captions, poses or highlights is a JSON edit, not a code change.

## Setup in Ghost
Create a **page** (not a post) with the slug **`how-to-read`**. Ghost uses the `page-how-to-read.hbs` template automatically. The title and excerpt become the heading and intro, and anything you write in the editor appears under the player. Every recipe table links here ("How to read this").

## Idea
**One minute, one recipe, two arms.** We never show a face or a kitchen, only the cook's arms, the ingredients and the tools, drawn as single-weight lines. Next to the drawing is the real recipe table, and it lights up in step with the cooking. The viewer should finish thinking "oh, it's just a map: left to right, everything comes together".

## Art direction
- **Line only.** One stroke weight (3 units on a 400×320 canvas), round caps and joins, no fills, no shading, no text in the drawing.
- **Colour comes from the theme.** Use `stroke="currentColor"`: dark lines on light themes, light lines on Night. Never hard-code a colour. The one splash of colour is branding (the flour bag's label): classes `brand` (filled with the palette's `--accent`) and `brand-mark` (drawn in `--accent-ink`), so it changes with the palette.
- **Draw-in.** Every shape draws itself in when its scene starts; the length is measured automatically, so any `<path>`, `<ellipse>`, `<circle>`, `<rect>`, `<line>` or `<polyline>` works. Draw each shape in the order you'd sketch it, because the path direction is the drawing direction.
- **Arms.** Only the hand that is doing something is shown (one hand whisks; ingredients, pours and the spatula move on their own). Arms enter from the bottom corners, with the shoulders off-canvas (left at −20,340, right at 420,340). Keep them simple and friendly: a sleeve line, a wrist, mitten-like hands. Poses rotate and translate each arm around its shoulder.
- **Props** sit on one counter line (y = 292). Keep them recognisable from the outline alone: a flour bag, a sugar jar, a milk bottle, an egg, a butter block, two bowls, a whisk, a pan, a pancake and a plate.
- **Motion.** Calm and readable. A loop of about 0.5 s for whisking, about 1 s for tapping, about 1.6 s for flipping. Nothing flashes, and the motion stops when the player is paused. With reduced motion turned on, everything is static.
- **The table is the hero.** The drawing is a supporting character; highlights on the table must always be readable.

### Layer ids (keep these when you replace the art)
| id | what | used in scenes |
|---|---|---|
| `arm-l`, `arm-r` | the two arms (groups, origin at the shoulder) | all |
| `flour`, `sugar`, `milk`, `egg`, `butter` | ingredients | ingredients, dry, wet |
| `bowl-a` | first bowl (dry) | dry, wet, fold |
| `bowl-b` (with an inner `.tilt` group) | second bowl (wet), tilts to pour | wet, fold |
| `whisk` (with an inner `.spin` group) | whisk | dry |
| `pan`, `pancake` (inner `.toss` group) | pan and pancake | dish |
| `plate` | stack of pancakes on a plate | done |

**Timed reveals.** A scene can list `"reveal": { "flour": 0, "sugar": 1 }` (prop id → recipe row): that drawing stays hidden until its row lights up, then draws itself in, so each ingredient appears exactly when the table names it.

**In-scene timeline** (seconds from the scene's start): `"poses": [{"at": 5.6, "pose": "whisk"}]` changes the arms mid-scene; `"show": {"whisk": 5.6}` brings a drawing in later; `"drops": [{"at": 0.6, "row": 0, "prop": "flour"}]` adds an ingredient: a copy of the prop flies into the bowl (`"into"`, default `bowl-a`), shrinking, and its amount pops up with a small burst ("+200 g"). Without `prop`, only the amount and name pop. `"crack": true` (for the egg) cracks the drawing along a zigzag instead of flying it: the shell halves tip away and the yolk drops in. Amounts and names come from the recipe row, and with `drops` the rows light up as they land.

Want more props or poses? Add an element with a new id, list it in a scene's `props`, and add a pose block in `theme/assets/css/screen.css` (search for `arm poses`).

## Storyboard (62 s, placeholder recipe: Sunday pancakes)
| # | Time | Scene id | Arms (pose) | Drawing | Table | Caption / voice-over (EN) |
|---|---|---|---|---|---|---|
| 1 | 0:00–0:07 | `intro` | `idle`, resting | counter line | whole table | This is a recipe, drawn as a map. You read it from left to right, like a sentence. |
| 2 | 0:07–0:16 | `ingredients` | `gather`, reaching in turn | flour, sugar, milk, egg and butter pop in | ingredient rows light up one by one | Down the left: every ingredient, in the order you will use it. It is your shopping list too. |
| 3 | 0:16–0:26 | `dry` | `idle`, then `whisk` at +5.6 s | the flour and the sugar fly into bowl A (+0.6 s, +1.9 s), baking powder and salt pop as text (+3.3 s, +4.5 s); then the hand brings the whisk and mixes | each row lights as it lands + the first "Whisk" | A step sits right next to what it uses. This Whisk covers the flour, sugar, baking powder and salt: whisk exactly those together. |
| 4 | 0:26–0:35 | `wet` | `idle`, then `whisk-b` at +5.6 s | the egg floats over bowl B and cracks, the yolk drops in (+1 s); the milk and the butter fly in (+2.6 s, +4 s); then the hand whisks bowl B | each row lights as it lands + the second "Whisk" | Steps in the same column can happen in any order. In a second bowl, whisk the milk, eggs and melted butter. |
| 5 | 0:35–0:44 | `fold` | `pour` bowl B into bowl A | both bowls (B tilts) | rows 1–7 + both Whisks + "Fold together" | Each new column combines everything to its left. Fold the two bowls together. |
| 6 | 0:44–0:54 | `dish` | `flip`: no hands, a spatula flicks the pancake up and catches it | electric hob in the worktop (glowing zone), pan, spatula, pancake tossing | everything + the dish | The last column is the dish: everything has come together. Cook each pancake two to three minutes per side. |
| 7 | 0:54–1:02 | `done` | `away` (no hands) | a stack of pancakes with butter and syrup, on a plate in the middle of the worktop | steps tick off one by one | Tap each step as you finish it, and change the servings at the top. That is all: now you can read any recipe here. |

Captions for all 6 languages are in `storyboard.json` (`scenes[].caption`). To use a different recipe, replace `recipe` in the JSON and adjust each scene's `highlight.rows` (ingredient row numbers, top to bottom from 0) and `highlight.steps` (step numbers from 0).

## Voice-over
- **Files:** `theme/assets/how-to-read/voice-en.mp3`, `voice-es.mp3`, `voice-fr.mp3`, `voice-pt.mp3`, `voice-it.mp3`, `voice-de.mp3`. Any language that's missing falls back to English; if there's none at all, the sound button reads "Voice-over coming soon".
- **One continuous file per language, 62 s**, with each caption starting at its scene's start time (±0.3 s; the player re-syncs while playing). The script is the caption text.
- **Delivery:** MP3, 128 kbps or more, mono is fine, around −16 LUFS, no music bed (or a very quiet one), half a second of silence at the start.
- If a recording runs long, stretch the scene's `start`/`end` in the JSON (and the total `duration`) rather than rushing the read.

## Player
Play/pause, restart, previous/next scene, a seek bar with chapter marks, speed (0.75× / 1× / 1.25× / 1.5× / 2×), captions on/off, sound on/off. Keys: Space or K to play/pause, ← → for scenes, C for captions, M for sound, R to restart, + / − for speed. Preferences are remembered per browser. It starts muted when scrolled into view (browsers only allow silent autoplay) and doesn't autoplay when reduced motion is on.
