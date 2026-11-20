# "How to read a recipe": storyboard & art direction

The page at `/how-to-read/` is an animated, captioned, narrated explainer of the recipe table. Everything it plays is described in **`theme/assets/how-to-read/storyboard.json`**. The drawings live in **`theme/partials/how-to-read-art.hbs`**, and the voice-over files go in **`theme/assets/how-to-read/`**. Changing timings, captions, poses or highlights is a JSON edit, not a code change.

## Setup in Ghost
Create a **page** (not a post) with the slug **`how-to-read`**. Ghost uses the `page-how-to-read.hbs` template automatically. The title and excerpt become the heading and intro, and anything you write in the editor appears under the player. Every recipe table links here ("How to read this").

## Idea
**One minute, one recipe, two arms.** We never show a face or a kitchen, only the cook's arms, the ingredients and the tools, drawn as single-weight lines. Next to the drawing is the real recipe table, and it lights up in step with the cooking. The viewer should finish thinking "oh, it's just a map: left to right, everything comes together".

## Art direction
- **Line only.** Round caps and joins, no fills, no shading, no text in the drawing. Hands use a **fine line (≈1.15 units on the 400×320 canvas)** like the references; the worktop is lighter (theme grey at half strength). The remaining placeholder props still use 3 units until they're redrawn.
- **Hands (chapter 1 is the model for the rest):** long, elegant fingers, nails as small closed rounded shapes, forearms as two long lines running out of frame. Perspective from the side, at table height; motion almost still.
- **Colour comes from the theme.** Use `stroke="currentColor"`: dark lines on light themes, light lines on Night. Never hard-code a colour.
- **Draw-in.** Every shape draws itself in when its scene starts; the length is measured automatically, so any `<path>`, `<ellipse>`, `<circle>`, `<rect>`, `<line>` or `<polyline>` works. Draw each shape in the order you'd sketch it, because the path direction is the drawing direction.
- **Arms.** Two arms enter from the bottom corners, with the shoulders off-canvas (left at −20,340, right at 420,340). Keep them simple and friendly: a sleeve line, a wrist, mitten-like hands. Poses rotate and translate each arm around its shoulder.
- **Props** sit on one counter line (y = 292). Keep them recognisable from the outline alone: a flour bag, a sugar jar, a milk bottle, an egg, a butter block, two bowls, a whisk, a pan, a pancake and a plate.
- **Motion.** Calm and readable. A loop of about 0.5 s for whisking, about 1 s for tapping, about 1.6 s for flipping. Nothing flashes, and the motion stops when the player is paused. With reduced motion turned on, everything is static.
- **The table is the hero.** The drawing is a supporting character; highlights on the table must always be readable.

### Layer ids (keep these when you replace the art)
| id | what | used in scenes |
|---|---|---|
| `hands-intro` (`.hand-l` palm up from the left, `.hand-r` palm down from the right) | **final art**, fine-line hands in the style of the references, almost still (a slow breath) | intro |
| `arm-l`, `arm-r` | the two arms (groups, origin at the shoulder), placeholder | all except intro |
| `.counter.wood` | the worktop: planks in perspective, light grey grain, runs past both edges | all (always visible) |
| `flour`, `sugar`, `milk`, `egg`, `butter` | ingredients | ingredients, dry, wet |
| `bowl-a` | first bowl (dry) | dry, wet, fold |
| `bowl-b` (with an inner `.tilt` group) | second bowl (wet), tilts to pour | wet, fold |
| `whisk` (with an inner `.spin` group) | whisk | dry |
| `pan`, `pancake` (inner `.toss` group) | pan and pancake | dish |
| `plate` | stack of pancakes on a plate | done |

Want more props or poses? Add an element with a new id, list it in a scene's `props`, and add a pose block in `theme/assets/css/screen.css` (search for `arm poses`).

## Storyboard (62 s, placeholder recipe: Sunday pancakes)
| # | Time | Scene id | Arms (pose) | Drawing | Table | Caption / voice-over (EN) |
|---|---|---|---|---|---|---|
| 1 | 0:00–0:07 | `intro` | `idle`: the placeholder arms hide; two fine-line hands (one offering from below, one reaching from above) draw themselves in and barely breathe | the wooden worktop | whole table | This is a recipe, drawn as a map. You read it from left to right, like a sentence. |
| 2 | 0:07–0:16 | `ingredients` | `gather`, reaching in turn | flour, sugar, milk, egg and butter pop in | ingredient rows light up one by one | Down the left: every ingredient, in the order you will use it. It is your shopping list too. |
| 3 | 0:16–0:26 | `dry` | `whisk` over bowl A | bowl A, whisk, flour, sugar | rows 1–4 + the first "Whisk" | A step sits right next to what it uses. This Whisk covers the flour, sugar, baking powder and salt: whisk exactly those together. |
| 4 | 0:26–0:35 | `wet` | `crack` an egg over bowl B | both bowls, egg, milk | rows 5–7 + the second "Whisk" | Steps in the same column can happen in any order. In a second bowl, whisk the milk, eggs and melted butter. |
| 5 | 0:35–0:44 | `fold` | `pour` bowl B into bowl A | both bowls (B tilts) | rows 1–7 + both Whisks + "Fold together" | Each new column combines everything to its left. Fold the two bowls together. |
| 6 | 0:44–0:54 | `dish` | `flip` the pancake | pan, pancake tossing | everything + the dish | The last column is the dish: everything has come together. Cook each pancake two to three minutes per side. |
| 7 | 0:54–1:02 | `done` | `serve` the plate | plate with a stack | steps tick off one by one | Tap each step as you finish it, and change the servings at the top. That is all: now you can read any recipe here. |

Captions for all 6 languages are in `storyboard.json` (`scenes[].caption`). To use a different recipe, replace `recipe` in the JSON and adjust each scene's `highlight.rows` (ingredient row numbers, top to bottom from 0) and `highlight.steps` (step numbers from 0).

## Voice-over
- **Files:** `theme/assets/how-to-read/voice-en.mp3`, `voice-es.mp3`, `voice-fr.mp3`, `voice-pt.mp3`, `voice-it.mp3`, `voice-de.mp3`. Any language that's missing falls back to English; if there's none at all, the sound button reads "Voice-over coming soon".
- **One continuous file per language, 62 s**, with each caption starting at its scene's start time (±0.3 s; the player re-syncs while playing). The script is the caption text.
- **Delivery:** MP3, 128 kbps or more, mono is fine, around −16 LUFS, no music bed (or a very quiet one), half a second of silence at the start.
- If a recording runs long, stretch the scene's `start`/`end` in the JSON (and the total `duration`) rather than rushing the read.

## Player
Play/pause, restart, previous/next scene, a seek bar with chapter marks, speed (0.75× / 1× / 1.25× / 1.5× / 2×), captions on/off, sound on/off. Keys: Space or K to play/pause, ← → for scenes, C for captions, M for sound, R to restart, + / − for speed. Preferences are remembered per browser. It starts muted when scrolled into view (browsers only allow silent autoplay) and doesn't autoplay when reduced motion is on.
