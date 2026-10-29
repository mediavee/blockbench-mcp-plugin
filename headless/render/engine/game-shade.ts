import { float, materialColor, min, normalWorld, pow, vec4 } from "three/tsl";
import { Mesh, MeshBasicNodeMaterial, MeshStandardMaterial, type Material, type Object3D } from "three/webgpu";

/**
 * Minecraft's directional face shade: 1 on top, 0.8 north and south, 0.6 east and west, 0.5 below,
 * blended by the squared normal for slanted faces. The game multiplies it into sRGB texels, so it
 * is raised to 2.2 here, where colours are linear, to darken as much on screen.
 */
function shadeNode() {
  const n = normalWorld;
  const shade = min(n.x.mul(n.x).mul(0.6).add(n.y.mul(n.y).mul(n.y.add(3).div(4))).add(n.z.mul(n.z).mul(0.8)), float(1));
  return pow(shade, float(2.2));
}

function shaded(material: Material): Material {
  if (!(material instanceof MeshStandardMaterial)) return material;
  const basic = new MeshBasicNodeMaterial({
    color: material.color,
    map: material.map,
    side: material.side,
    transparent: material.transparent,
    alphaTest: material.alphaTest,
    depthWrite: material.depthWrite,
  });
  // A glowing part keeps full brightness in game, as it does here.
  if (material.emissiveIntensity <= 0 || material.emissive.getHex() === 0) {
    const shade = shadeNode();
    basic.colorNode = materialColor.mul(vec4(shade, shade, shade, 1));
  }
  return basic;
}

/**
 * Swaps the model's lit materials for unlit ones shaded per face as the game does, so a preview
 * shows the texture's own colours under in-game shading rather than a studio rig's.
 *
 * @returns A function that frees the materials it created; the originals stay with the model.
 */
export function applyGameShade(root: Object3D): () => void {
  const created: Material[] = [];
  const swap = (material: Material): Material => {
    const next = shaded(material);
    if (next !== material) created.push(next);
    return next;
  };
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.material = Array.isArray(object.material) ? object.material.map(swap) : swap(object.material);
  });
  return () => created.forEach((material) => material.dispose());
}
