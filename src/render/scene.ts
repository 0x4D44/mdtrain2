import * as THREE from "three";
import type { Route } from "../sim/route";

export interface SceneHandle {
  /** Place the driver's eye at a chainage (m) and render. */
  render(chainage: number): void;
  resize(): void;
}

// Minimal night scene: ground, two rails and sleepers along the chainage axis
// (mapped straight to world +Z for Phase 0), plus moonlight and fog. Enough to
// see the sim driving the camera; the real cab and wet-night look come later.
export function createScene(parent: HTMLElement, route: Route): SceneHandle {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(parent.clientWidth, parent.clientHeight);
  parent.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x070b12);
  scene.fog = new THREE.Fog(0x070b12, 30, 320);

  const camera = new THREE.PerspectiveCamera(70, parent.clientWidth / parent.clientHeight, 0.1, 2000);

  scene.add(new THREE.HemisphereLight(0x223044, 0x05070a, 0.6));
  const moon = new THREE.DirectionalLight(0x9fb4d6, 0.5);
  moon.position.set(-40, 80, -20);
  scene.add(moon);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(400, route.length + 400),
    new THREE.MeshStandardMaterial({ color: 0x0c1410, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.z = route.length / 2;
  scene.add(ground);

  // Rails
  const gauge = 1.435;
  const railMat = new THREE.MeshStandardMaterial({ color: 0x3a4250, metalness: 0.8, roughness: 0.4 });
  for (const x of [-gauge / 2, gauge / 2]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.12, route.length), railMat);
    rail.position.set(x, 0.06, route.length / 2);
    scene.add(rail);
  }

  // Sleepers as one instanced mesh.
  const spacing = 0.65;
  const count = Math.floor(route.length / spacing);
  const sleepers = new THREE.InstancedMesh(
    new THREE.BoxGeometry(2.6, 0.12, 0.25),
    new THREE.MeshStandardMaterial({ color: 0x161a1e, roughness: 1 }),
    count,
  );
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    m.setPosition(0, 0.02, i * spacing);
    sleepers.setMatrixAt(i, m);
  }
  sleepers.instanceMatrix.needsUpdate = true;
  scene.add(sleepers);

  function render(chainage: number): void {
    camera.position.set(0, 1.9, chainage - 0.6);
    camera.lookAt(0, 1.6, chainage + 30);
    renderer.render(scene, camera);
  }

  function resize(): void {
    const w = parent.clientWidth, h = parent.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  return { render, resize };
}
