# Nanobanana Image Studio — Examples

## Example 1: Generate a product hero image

> "Generate a hero image of wireless headphones floating on a dark gradient background"

**Tool:** `generate_image`
```json
{
  "prompt": "Premium wireless headphones floating on a dark gradient background, dramatic product lighting, sleek matte black finish with subtle reflections",
  "aspect_ratio": "16:9",
  "image_size": "2K",
  "thinking_level": "high"
}
```

**Result:** Image saved to `~/Desktop/nanobanana-output/2026-03-22-premium-wireless-headphones-a1b2c3.png`

---

## Example 2: Extract Visual DNA and apply to new subject

> "Match the style of this brand photo for a new product shot"

**Step 1 — Extract DNA:**
**Tool:** `extract_visual_dna`
```json
{
  "images": ["/path/to/brand-reference.jpg"]
}
```

**Result:**
```json
{
  "style": "clean commercial photography, modern minimalist",
  "scene": "pure white background, soft shadow",
  "subject": "centered product, floating composition",
  "camera": "85mm lens, f/5.6, straight-on angle",
  "lighting": "soft diffused studio light, even illumination",
  "materials": "matte plastic, brushed metal accents",
  "colors": "neutral whites, product true-color, no color cast"
}
```

**Step 2 — Generate with DNA:**
**Tool:** `generate_image`
```json
{
  "prompt": "A smart water bottle with LED temperature display",
  "visual_dna": {
    "style": "clean commercial photography, modern minimalist",
    "scene": "pure white background, soft shadow",
    "camera": "85mm lens, f/5.6, straight-on angle",
    "lighting": "soft diffused studio light, even illumination",
    "materials": "matte plastic, brushed metal accents",
    "colors": "neutral whites, product true-color, no color cast"
  },
  "image_size": "2K"
}
```

**Result:** New product shot matching the original brand aesthetic.

---

## Example 3: Edit an existing image

> "Change the background of this photo to a sunset beach"

**Tool:** `edit_image`
```json
{
  "images": ["/path/to/portrait.jpg"],
  "prompt": "Replace the background with a golden sunset beach scene, keep the subject exactly as-is",
  "thinking_level": "high"
}
```

**Result:** Edited image saved with the new background while preserving the subject.

---

## Example 4: Use a built-in style template

> "Create a noir-style cityscape"

**Step 1 — Browse templates:**
**Tool:** `list_templates`

**Result:**
```
Available templates:
- blueprint_3d: Technical Blueprint, 3D orthographic projection
- cinematic_fujifilm: Cinematic Fujifilm, highly detailed, film grain
- flat_vector: Flat vector design, modern minimalist, clean geometric shapes
- isometric_3d: Isometric 3D illustration, game art, playful and detailed
- noir_dramatic: Film noir, high contrast black and white, dramatic cinematic
- product_photography: Clean product photography, e-commerce ready, professional
- vintage_polaroid: Vintage Polaroid instant film, nostalgic, slightly faded
- watercolor_illustration: Loose watercolor illustration, hand-painted feel, artistic
```

**Step 2 — Get template:**
**Tool:** `get_template`
```json
{ "name": "noir_dramatic" }
```

**Step 3 — Generate with template:**
**Tool:** `generate_image`
```json
{
  "prompt": "A lone detective standing under a streetlight in a rain-soaked city alley",
  "visual_dna": {
    "style": "Film noir, high contrast black and white, dramatic cinematic",
    "scene": "Urban nighttime, rain-slicked streets, venetian blind shadows",
    "lighting": "Single harsh key light, deep shadows, chiaroscuro, rim lighting",
    "camera": "50mm lens, f/2, low angle or Dutch angle, shallow depth of field",
    "materials": "Glossy wet surfaces, smoke or fog, matte skin, textured concrete",
    "colors": "Pure black and white, deep blacks, bright highlights, no midtones"
  }
}
```

---

## Example 5: Autonomous email workflow (Claude Cowork)

> "Create a product launch email with custom images"

Claude Cowork chains tools automatically:

1. `generate_image` → hero banner (16:9, 2K)
2. `generate_image` → lifestyle product shot (4:3)
3. `describe_image` → alt text for accessibility
4. `gmail_create_draft` → compose email with images attached
