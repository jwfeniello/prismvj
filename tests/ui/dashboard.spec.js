import { test, expect } from '@playwright/test';

test('clip dashboard dial and label highlight update the live editor', async ({page}) => {
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');
  const panel=page.locator('[data-inspector-panel="clip"]');
  await panel.locator('[data-dashboard-assign="0"]').selectOption('opacity');
  await panel.locator('[data-dashboard-value="0"]').evaluate(input=>{
    input.value='.31';input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  let project=await page.evaluate(()=>window.prismDiagnostics().project);
  const clip=project.layers.flatMap(layer=>Object.values(layer.clips).flat()).find(item=>item?.id===project.layers.at(-1).activeClipId);
  expect(clip.opacity).toBeCloseTo(.31,2);
  expect(clip.dashboard[0].key).toBe('opacity');
  await panel.locator('[data-dashboard-source="volume"]').dragTo(panel.locator('[data-dashboard-slot="1"]'));
  project=await page.evaluate(()=>window.prismDiagnostics().project);
  expect(project.layers.flatMap(layer=>Object.values(layer.clips).flat()).find(item=>item?.id===clip.id).dashboard[1].key).toBe('volume');
  await panel.locator('#clip-label-color').fill('#b8e1ff');
  project=await page.evaluate(()=>window.prismDiagnostics().project);
  const colored=project.layers.flatMap(layer=>Object.values(layer.clips).flat()).find(item=>item?.id===clip.id);
  expect(colored.labelColor).toBe('#b8e1ff');
  await expect(page.locator(`.clip-slot[data-clip="${clip.id}"]`)).toHaveClass(/has-label-color/);
  expect(errors).toEqual([]);
});

test('composition dashboard drives the master output parameter', async ({page}) => {
  await page.goto('/');
  await page.locator('[data-inspector="composition"]').click();
  const panel=page.locator('[data-inspector-panel="context"]');
  await panel.locator('[data-dashboard-assign="0"]').selectOption('masterOpacity');
  await panel.locator('[data-dashboard-value="0"]').evaluate(input=>{
    input.value='.4';input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  const project=await page.evaluate(()=>window.prismDiagnostics().project);
  expect(project.masterOpacity).toBeCloseTo(.4,2);
  expect(project.dashboard[0].key).toBe('masterOpacity');
});
