# ▲ Everest Scale

A phone-first web app: take a photo of any mountain and it puts a to-scale Mt. Everest behind it.

## How it works
1. **Take a photo** (opens the rear camera on phones) or pick one from your library.
2. The app finds the sky automatically and guesses the summit. Drag the **yellow** marker to the peak and the **green** marker to the mountain's foot.
3. Choose the mountain from the list, type in its elevation, or tap **Use my location**. That uses GPS (or the Open-Meteo elevation API) for the base elevation and lists nearby named peaks from OpenStreetMap (Overpass API).
4. Everest (8,849 m) is drawn at the same pixels-per-metre scale, measured from the same base elevation and set at the same distance, and is masked so it only shows in the sky, *behind* your mountain. Drag sideways to slide it.
5. **Save / share** exports a JPEG (uses the native share sheet on phones).

**Scale:** `pixels per metre = (base marker y − summit marker y) / (summit elevation − base elevation)`.
Everest's summit is drawn `(8849 − base elevation) × pixels-per-metre` above the base marker.

## Run locally
It's plain static HTML/CSS/JS with no build step:
```
cd everest-scale && python3 -m http.server 8000
```
Camera capture works on any origin, but **Use my location** needs HTTPS (or localhost).

## Deploy
Any static host works. For GitHub Pages: Settings → Pages → deploy from branch, then open `/everest-scale/`.
