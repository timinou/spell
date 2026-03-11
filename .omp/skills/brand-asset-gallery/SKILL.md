---
name: brand-asset-gallery
description: Generate brand asset variations (ad creatives, logos, mood boards) using gemini-image, display them in a native Qt QML gallery window, and let users rate/compare/regenerate without touching the terminal.
---

# Brand Asset Gallery

Generate visual brand assets, display them in an interactive Qt QML gallery, and iterate based on user ratings and feedback — all within a single session.

## When to use

User asks to:
- Generate logo variations, ad creatives, social media assets, mood boards, or any set of image variations
- Visually compare and rate generated images
- Iterate on image generation with visual feedback

## Workflow

### 1. Generate initial batch

Use `gemini_image` to produce N variations (default 4, max 8). Vary prompts to explore the design space:
- Vary composition, color palette, style, or weight
- Save all images to `/tmp/omp-gallery/<session-id>/` where `session-id` is a short random slug (e.g. `brand-1a2b`)
- Track each image as `{ id: "img-1", path: "/tmp/omp-gallery/<session>/img-1.png", prompt: "...", rating: 0, selected: false }`

```
gemini_image subject="minimalist tech startup logo, lightning bolt, dark navy background" style="flat vector, clean edges" path="/tmp/omp-gallery/brand-1a2b/img-1.png"
```

### 2. Write and launch the QML gallery

Write the gallery QML file using `qml write`, then launch it with the image list as props:

```
qml write path="/tmp/omp-gallery/brand-1a2b/gallery.qml" content=<contents of skill://brand-asset-gallery/gallery.qml>
qml launch id="brand-1a2b" path="/tmp/omp-gallery/brand-1a2b/gallery.qml" props={ "images": [ { "id": "img-1", "path": "/tmp/omp-gallery/brand-1a2b/img-1.png", "prompt": "...", "rating": 0 }, ... ] }
```

The `id` you use for `qml launch` becomes the session handle for all subsequent `qml send_message` calls.

### 3. Event loop

After launching, **immediately** call `qml send_message` with `wait_for_event: true` — do not yield to the user first. The call blocks until the window emits an event. Handle the event, then call again to keep the loop alive.

#### Event: `rate`
Payload: `{ action: "rate", id: "img-2", rating: 4 }`
- Store the rating internally
- Use ratings to guide future generation: higher-rated images' prompts get more weight

#### Event: `select`
Payload: `{ action: "select", id: "img-3", selected: true }`
- Track which images the user has checked for batch operations

#### Event: `regenerate`
Payload: `{ action: "regenerate", ids: ["img-1", "img-3"], feedback: "more blue, less busy" }`
- Generate new variations, incorporating:
  - The feedback text
  - The prompts of any referenced (and highly-rated) images as style anchors
- Assign new ids (e.g. `img-5`, `img-6`, ...)
- Send the new images to the gallery:
  ```
  qml send_message id="<session-id>" payload={ "action": "add_images", "images": [ { "id": "img-5", "path": "...", "prompt": "..." } ] }
  ```

#### Event: `generate_more`
Payload: `{ action: "generate_more", count: 4 }`
- Generate `count` new variations using refined prompts based on ratings so far
- Send results via `add_images` message (same as regenerate)

#### Event: `export`
Payload: `{ action: "export", ids: ["img-2", "img-5"], directory: "/home/user/exports" }`
- Copy the listed image files to the given directory (default `~/Downloads/brand-assets/`)
- Confirm export to the user in chat

#### Event: `close`
Payload: `{ action: "close" }`
- Exit the event loop
- Summarize the session: how many images generated, which were rated highest, what was exported

### 4. Prompt refinement strategy

When generating follow-up images:
- Start from the base user description
- Append feedback verbatim as a directional modifier
- If specific images were referenced, extract their prompts and blend: take the shared keywords and add the new direction
- Always vary at least one dimension (color, composition, weight, texture) per batch to maintain diversity

## Message protocol (agent → gallery)

Send via `qml send_message id="<session-id>" payload={...}`:

| `action`       | Additional fields                          | Effect                                      |
|----------------|--------------------------------------------|---------------------------------------------|
| `add_images`   | `images: [{id, path, prompt, rating}]`     | Append new image cards to the grid          |
| `remove_image` | `id: string`                               | Remove a card (e.g. after user discards it) |
| `set_rating`   | `id: string, rating: number`               | Sync a rating back to the gallery           |
| `notify`       | `message: string`                          | Show a brief status toast in the gallery    |

## Session state to maintain

Keep this in memory during the loop:

```typescript
interface SessionState {
  sessionId: string;
  basePrompt: string;      // original user request
  images: Map<string, {    // id → metadata
    path: string;
    prompt: string;
    rating: number;        // 0 = unrated
    selected: boolean;
  }>;
  nextIndex: number;       // for sequential img-N ids
}
```

## Error handling

- If `gemini_image` fails for one variation, continue with the rest and note the failure
- If the QML window closes unexpectedly (`closed` event), offer to relaunch with the current image set
- If `/tmp/omp-gallery/` does not exist, create it before writing images

## Example session

```
User: Create 4 variations of a minimalist fintech app icon with an upward arrow

Agent:
1. Generate 4 images → img-1 through img-4
2. Write gallery.qml, launch id="fintech-3f9c" with image paths
3. Wait for events...
   - {action:"rate", id:"img-2", rating:5} → note img-2 is top pick
   - {action:"regenerate", ids:["img-2"], feedback:"make the arrow gold"} →
       generate img-5 img-6 with gold arrow anchored on img-2's style →
       send add_images to gallery
   - {action:"export", ids:["img-5"], directory:""} →
       copy img-5 to ~/Downloads/brand-assets/ →
       "Exported img-5 to ~/Downloads/brand-assets/img-5.png"
   - {action:"close"} →
       "Session complete. Generated 6 images. Top rated: img-2 (★5), img-5 (★4). Exported: img-5."
```
