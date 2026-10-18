import { test, expect } from '@playwright/test';

async function pngFromDownload(download) {
  const chunks=[];
  for await (const chunk of await download.createReadStream()) chunks.push(chunk);
  const png=Buffer.concat(chunks);
  expect(png.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
  expect(png.readUInt32BE(16)).toBe(1280);
  expect(png.readUInt32BE(20)).toBe(720);
  return png;
}

test('output and clip snapshots download PNGs and fill bottom-layer slots', async ({page}) => {
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/');
  let project=await page.evaluate(()=>prismDiagnostics().project);
  const bottomId=project.layers[0].id,deckId=project.selectedDeckId;
  const output=page.waitForEvent('download');
  await page.locator('#snapshot-output').click();
  await pngFromDownload(await output);
  await expect(page.locator(`.layer-row[data-layer="${bottomId}"] [data-slot="4"]`)).toHaveAttribute('data-clip',/clip-/);
  project=await page.evaluate(()=>prismDiagnostics().project);
  expect(project.layers[0].clips[deckId][4].kind).toBe('image');
  const clip=page.waitForEvent('download');
  await page.locator('#snapshot-clip').click();
  await pngFromDownload(await clip);
  await expect(page.locator(`.layer-row[data-layer="${bottomId}"] [data-slot="5"]`)).toHaveAttribute('data-clip',/clip-/);
  project=await page.evaluate(()=>prismDiagnostics().project);
  expect(project.layers[0].clips[deckId][5].kind).toBe('image');
  expect(errors).toEqual([]);
});

test('clip snapshot preserves transparent pixels and straight color', async ({page}) => {
  await page.goto('/');
  const project=await page.evaluate(()=>prismDiagnostics().project),layerId=project.layers.at(-1).id;
  const base64=await page.evaluate(()=>{
    const canvas=document.createElement('canvas');canvas.width=canvas.height=4;
    const context=canvas.getContext('2d');context.fillStyle='rgba(0,255,0,.5)';context.fillRect(1,1,2,2);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const chooser=page.waitForEvent('filechooser');
  await page.locator(`.layer-row[data-layer="${layerId}"] [data-slot="4"]`).dblclick();
  await (await chooser).setFiles({name:'snapshot-alpha.png',mimeType:'image/png',buffer:Buffer.from(base64,'base64')});
  await expect(page.locator(`.layer-row[data-layer="${layerId}"] [data-slot="4"]`)).toHaveAttribute('data-clip',/clip-/);
  const download=page.waitForEvent('download');
  await page.locator('#snapshot-clip').click();
  const png=await pngFromDownload(await download);
  const pixels=await page.evaluate(async bytes=>{
    const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)],{type:'image/png'}));
    const canvas=document.createElement('canvas');canvas.width=bitmap.width;canvas.height=bitmap.height;
    const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);
    return {outside:[...context.getImageData(100,100,1,1).data],inside:[...context.getImageData(640,360,1,1).data]};
  },[...png]);
  expect(pixels.outside[3]).toBe(0);
  expect(pixels.inside[1]).toBeGreaterThan(240);
  expect(pixels.inside[3]).toBeGreaterThan(105);
  expect(pixels.inside[3]).toBeLessThan(150);
});
