import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, serializeProject, validateProject } from '../src/model.js';
import { assignDashboard, moveDashboard, syncDashboard } from '../src/dashboard.js';

test('dashboard dials control clip, layer, and composition parameters and survive save', () => {
  const project=createProject(),layer=project.layers[0],clip=layer.clips[project.selectedDeckId][0];
  assert.equal(assignDashboard(clip,'clip',0,'opacity'),true);
  assert.equal(assignDashboard(layer,'layer',2,'transition'),true);
  assert.equal(assignDashboard(project,'composition',7,'bpm'),true);
  assert.equal(moveDashboard(clip,'clip',0,.27),true);
  assert.equal(moveDashboard(layer,'layer',2,.5),true);
  assert.equal(moveDashboard(project,'composition',7,.25),true);
  assert.equal(clip.opacity,.27);
  assert.equal(layer.transition,5);
  assert.equal(project.bpm,90);
  clip.opacity=.6;syncDashboard(clip,'clip','opacity');
  assert.equal(clip.dashboard[0].value,.6);
  const saved=serializeProject(project),restored=validateProject(saved);
  assert.deepEqual(restored.dashboard,project.dashboard);
  assert.deepEqual(restored.layers[0].dashboard,layer.dashboard);
  assert.deepEqual(restored.layers[0].clips[restored.selectedDeckId][0].dashboard,clip.dashboard);
});

test('clip highlight survives validation and invalid dashboard targets are discarded', () => {
  const project=createProject(),clip=project.layers[0].clips[project.selectedDeckId][0];
  clip.labelColor='#b8e1ff';
  clip.dashboard[0]={key:'__proto__',value:100};
  assert.equal(assignDashboard(clip,'clip',1,'__proto__'),false);
  const restored=validateProject(project).layers[0].clips[project.selectedDeckId][0];
  assert.equal(restored.labelColor,'#b8e1ff');
  assert.deepEqual(restored.dashboard[0],{key:null,value:0});
});
