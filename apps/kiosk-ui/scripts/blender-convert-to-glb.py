import bpy
import os
import sys


def parse_args():
    if '--' not in sys.argv:
        raise RuntimeError('Missing args delimiter --')
    idx = sys.argv.index('--')
    args = sys.argv[idx + 1 :]
    if len(args) < 2:
        raise RuntimeError('Usage: blender --background --python blender-convert-to-glb.py -- <source> <target.glb>')
    return args[0], args[1]


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def ensure_dir(target_path):
    directory = os.path.dirname(target_path)
    if directory:
        os.makedirs(directory, exist_ok=True)


def import_source(source_path):
    ext = os.path.splitext(source_path)[1].lower()
    if ext == '.blend':
        bpy.ops.wm.open_mainfile(filepath=source_path)
        return

    reset_scene()

    if ext == '.fbx':
        bpy.ops.import_scene.fbx(filepath=source_path)
        return

    if ext == '.obj':
        bpy.ops.import_scene.obj(filepath=source_path)
        return

    raise RuntimeError(f'Unsupported source extension: {ext}')


def export_glb(target_path):
    ensure_dir(target_path)
    bpy.ops.export_scene.gltf(
        filepath=target_path,
        export_format='GLB',
        export_yup=True,
        export_apply=True,
        export_animations=True,
        export_morph=True,
        export_lights=False,
        export_cameras=False,
    )


def main():
    source_path, target_path = parse_args()
    source_path = os.path.abspath(source_path)
    target_path = os.path.abspath(target_path)

    if not os.path.exists(source_path):
        raise RuntimeError(f'Source not found: {source_path}')

    import_source(source_path)
    export_glb(target_path)
    print(f'[blender-convert] OK: {source_path} -> {target_path}')


if __name__ == '__main__':
    main()
