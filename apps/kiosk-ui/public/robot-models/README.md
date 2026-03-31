# Robot Models Folder (Auto Pipeline)

You can drop any of these into this folder (or subfolders):

- Runtime-ready: `.glb`, `.gltf`
- Source files (auto-convert when Blender is available): `.blend`, `.fbx`, `.obj`
- Archive: `.zip` (auto-extract on Windows)

Then run:

- `npm --prefix apps/kiosk-ui run robot-models:sync`

What it does automatically:

1. Extract `.zip` files into sibling folders (Windows).
2. Convert `.blend/.fbx/.obj` to `.glb` if Blender is found.
3. Regenerate `manifest.json` for Admin dropdown.

If Blender is not detected:

- Install Blender, or
- Set env var `BLENDER_PATH` to your `blender.exe` path.

Example (PowerShell):

```powershell
$env:BLENDER_PATH = 'C:\Program Files\Blender Foundation\Blender\blender.exe'
npm --prefix apps/kiosk-ui run robot-models:sync
```
