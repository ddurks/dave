"""Export davebot.blend to the GLB the scene loads.

usage: /Applications/Blender.app/Contents/MacOS/Blender -b body/blender/davebot.blend \
         --python body/blender/export_davebot.py -- [out.glb]

The tibia IK constraints are a Blender-only preview of the rig dave-gait.js
drives at runtime. They're forced off here, because the exporter samples
every action through constraints and would otherwise bake the legs onto
the IK targets' rest positions.
"""
import os
import sys

import bpy

HERE = os.path.dirname(bpy.data.filepath)
argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if argv else os.path.join(HERE, "..", "assets", "davebot.glb")

arm = bpy.data.objects["Armature"]
for pb in arm.pose.bones:
    for c in pb.constraints:
        if c.type == "IK":
            c.mute = True

bpy.ops.export_scene.gltf(
    filepath=OUT,
    export_format="GLB",
    export_extras=True,  # gait_* tuning on the Armature
    export_animations=True,
)
print(f"wrote {os.path.abspath(OUT)}")
