import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, validateProject, serializeProject } from '../src/model.js';
import { visibleSlot, setPersistent } from '../src/persistent-clips.js';
import { moveClip, copyClip, pasteClip, insertColumn } from '../src/composition.js';
import { applyOSC } from '../src/controls.js';

test('persistent clip covers a deck slot without deleting its original clip', () => {
  const project=createProject(),layer=project.layers[0],home=project.decks[0].id,other=project.decks[1].id;
  const pin=layer.clips[home][0],covered=layer.clips[other][0];
  setPersistent(project,pin.id,true);
  assert.equal(visibleSlot(project,layer,other,0).clip,pin);
  assert.equal(visibleSlot(project,layer,other,0).covered,covered);
  assert.equal(layer.clips[other][0],covered);
  assert.equal(visibleSlot(project,layer,home,0).covered,null);
  const restored=validateProject(serializeProject(project));
  assert.equal(restored.layers[0].clips[home][0].persistent,true);
  assert.equal(visibleSlot(restored,restored.layers[0],other,0).covered.id,covered.id);
  setPersistent(project,pin.id,false);
  assert.equal(visibleSlot(project,layer,other,0).clip,covered);
});

test('a covered clip can move out; copying a persistent clip does not make another persistent slot', () => {
  const project=createProject(),layer=project.layers[0],home=project.decks[0].id,other=project.decks[1].id;
  const pin=layer.clips[home][0],covered=layer.clips[other][0];
  setPersistent(project,pin.id,true);
  moveClip(project,{layerId:layer.id,deckId:other,column:0},{layerId:layer.id,deckId:other,column:4});
  assert.equal(layer.clips[other][4],covered);
  assert.equal(layer.clips[other][0],null);
  assert.equal(visibleSlot(project,layer,other,0).clip,pin);
  assert.throws(()=>pasteClip(project,{layerId:layer.id,deckId:other,column:0},copyClip(project,{layerId:layer.id,deckId:home,column:0})),/covered/);
  const copy=copyClip(project,{layerId:layer.id,deckId:home,column:0});
  const duplicate=pasteClip(project,{layerId:layer.id,deckId:other,column:5},copy);
  assert.equal(duplicate.persistent,false);
  insertColumn(project,0);
  assert.equal(visibleSlot(project,layer,other,1).clip,pin);
});

test('new persistence wins a slot and OSC addresses target the visible persistent clip', () => {
  const project=createProject(),layer=project.layers[0],home=project.decks[0].id,other=project.decks[1].id;
  const first=layer.clips[home][0],second=layer.clips[other][0];
  setPersistent(project,first.id,true);
  project.selectedDeckId=other;
  let triggered=null;
  assert.equal(applyOSC({project,triggerClip:(_layer,clip)=>{triggered=clip.id;}},{address:'/layer1/clip1/connect',args:[1]}),true);
  assert.equal(triggered,first.id);
  setPersistent(project,second.id,true);
  assert.equal(first.persistent,false);
  assert.equal(visibleSlot(project,layer,home,0).clip,second);
  first.persistent=true;
  const restored=validateProject(project);
  assert.equal(restored.layers[0].clips[home][0].persistent,true);
  assert.equal(restored.layers[0].clips[other][0].persistent,false);
});
