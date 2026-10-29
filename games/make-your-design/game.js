// 1. imports
import * as THREE from 'three';
import { adapter } from './platform.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';

// Distribution adapters own platform services; gameplay remains entirely static.
const platform = { adapter, gameplay:false, desiredGameplay:false, eventAdapter:null, eventTimer:null, lastEvents:{}, loading:false, muteAudio:false, memory:new Map(), storageFailed:false };
const SETTINGS_KEY = 'makeYourDesignSettingsV1';
let onboardingSeen = false;
let gameReady = false;
let runGeneration = 0;
let manualPaused = false;
const suspendReasons = new Set();
let suspendedAt = null;
let suspendedDuration = 0;
const gameTasks = new Map();
let nextTaskId = 0;
const touchInput = { x:0, y:0, pointerId:null };
const touchDevice = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
const gameViewport = readGameViewport();
let compactMode = false;
const compactPanelHomes = new Map();
function readGameViewport() {
  const viewport=window.visualViewport;
  return {width:Math.max(1,Math.round(viewport?.width||innerWidth)),height:Math.max(1,Math.round(viewport?.height||innerHeight)),left:viewport?.offsetLeft||0,top:viewport?.offsetTop||0};
}
function updateInputHints() {
  document.body.classList.toggle('touch-device',touchDevice);
  document.querySelector('.title-controls').innerHTML=touchDevice
    ? '<span>JOYSTICK TO MOVE</span><span>JUMP · INTERACT · DROP · BAG · GUIDE</span>'
    : '<kbd>WASD</kbd> MOVE <kbd>SPACE</kbd> JUMP <kbd>E</kbd> ACCEPT / TAKE <kbd>Q</kbd> DROP <kbd>B</kbd> BAG <kbd>G</kbd> GUIDE';
  document.querySelector('#interaction-prompt kbd').textContent=touchDevice?'INTERACT':'E';
  document.querySelector('#stop-craft').textContent=touchDevice?'STOP · TAP':'STOP · SPACE';
  document.querySelector('#town-map-caption').textContent=touchDevice?'Meet a customer · tap INTERACT to accept':'Meet a customer · E to accept';
  document.querySelector('#bag-full-warning').innerHTML=touchDevice
    ? '<strong>BAG FULL</strong><span>DROP an item or open BAG. Store spares at MY SHOP.</span>'
    : '<strong>BAG FULL</strong><span><kbd>Q</kbd> DROP · <kbd>B</kbd> BAG · store spares at MY SHOP</span>';
}
// Apply device instructions before loading the town, including the title screen.
updateInputHints();
function gameNow() { return (suspendedAt ?? performance.now()) - suspendedDuration; }
function simulationSuspended() { return suspendReasons.size > 0; }
function setGameTimeout(callback, delay) {
  const id = ++nextTaskId;
  gameTasks.set(id,{at:gameNow()+delay,callback,generation:runGeneration});
  return id;
}
function clearGameTimeout(id) { gameTasks.delete(id); }
function updateGameTasks(now) {
  for (const [id,task] of [...gameTasks]) {
    if(task.generation!==runGeneration)gameTasks.delete(id);
    else if(now>=task.at){gameTasks.delete(id);task.callback();}
  }
}
function clearInput() {
  keys.clear();touchInput.x=0;touchInput.y=0;touchInput.pointerId=null;
  if(typeof velocity!=='undefined')velocity.set(0,0,0);
  const thumb=document.querySelector('#joystick-thumb');if(thumb)thumb.style.transform='translate(0,0)';
}
function setSuspended(reason, value) {
  const wasSuspended=simulationSuspended();
  if(value)suspendReasons.add(reason);else suspendReasons.delete(reason);
  if(!wasSuspended&&simulationSuspended()){suspendedAt=performance.now();clearInput();}
  if(wasSuspended&&!simulationSuspended()){suspendedDuration+=performance.now()-suspendedAt;suspendedAt=null;clock.getDelta();}
  syncAudio();
}
function platformEvent(name) { try { platform.adapter.event(name); } catch {} }
function syncPlatformGameplay() {
  if(platform.eventAdapter!==platform.adapter){
    clearTimeout(platform.eventTimer);platform.eventTimer=null;platform.eventAdapter=platform.adapter;platform.lastEvents={};platform.gameplay=false;
  }
  platform.desiredGameplay=gameReady&&gameState.started&&!gameState.gameOver&&!gameState.modalOpen&&!manualPaused;
  flushPlatformGameplay();
}
function flushPlatformGameplay() {
  clearTimeout(platform.eventTimer);platform.eventTimer=null;
  if(platform.desiredGameplay===platform.gameplay)return;
  const event=platform.desiredGameplay?'gameplayStart':'gameplayStop';
  const delay=1050-(performance.now()-(platform.lastEvents[event]??-Infinity));
  if(delay>0){platform.eventTimer=setTimeout(flushPlatformGameplay,delay);return;}
  platform.gameplay=platform.desiredGameplay;platform.lastEvents[event]=performance.now();platformEvent(event);
}
function readSaved(key) {
  try {
    const value=platform.adapter.read(key);
    if(value!==null)platform.memory.set(key,value);
    return value;
  } catch { platform.storageFailed=true;return platform.memory.get(key)??null; }
}
function writeSaved(key,value) {
  platform.memory.set(key,value);
  try {
    platform.adapter.write(key,value);
  } catch { platform.storageFailed=true; }
}
function saveSettings() { writeSaved(SETTINGS_KEY,JSON.stringify({soundEnabled:gameState.soundEnabled,onboardingSeen})); }
function loadSettings() {
  try {
    const saved=JSON.parse(readSaved(SETTINGS_KEY)||'{}');
    gameState.soundEnabled=saved?.soundEnabled!==false;
    onboardingSeen=saved?.onboardingSeen===true;
  } catch { gameState.soundEnabled=true;onboardingSeen=false; }
  syncAudio();
}
function syncAudio() {
  const muted=!gameState.soundEnabled||platform.muteAudio||simulationSuspended();
  if(masterGain){
    // Clear earlier transition events, including a suspended context's frozen time.
    masterGain.gain.cancelScheduledValues(0);
    masterGain.gain.value=muted?0:.105;
  }
  musicController.setMuted(muted);
  document.querySelector('#sound-state').textContent=platform.muteAudio?'MUTED':gameState.soundEnabled?'ON':'OFF';
}
async function initPlatform() {
  try {
    await platform.adapter.init({onMuteChange:muted=>{platform.muteAudio=Boolean(muted);syncAudio();}});
    platform.loading=true;platformEvent('loadingStart');
  } catch { /* Platform initialization must not prevent ordinary static play. */ }
}

function setManualPause(paused) {
  if(!gameState.started||gameState.gameOver)return;
  manualPaused=paused;setSuspended('manual',paused);
  document.querySelector('#pause-screen').classList.toggle('active',paused);
  syncPlatformGameplay();updateControlVisibility();
  if(paused)document.querySelector('#resume-button').focus();
}

// 2. fixed constants
const C = Object.freeze({
  lavender: 0x7B4DFF, mint: 0x54DDD0, peach: 0xFF9877, sky: 0x70CFFF,
  yellow: 0xFFD84A, coral: 0xFF4F9A, cream: 0xFFF4DF, grass: 0xBFD4A9,
  path: 0xFFE8CF, pathEdge: 0xE7C49F, ink: 0x29213D, gold: 0xFFD84A,
  brown: 0xA96F55, leaf: 0x58B978, darkMint: 0x289E93, urgent:0xFF465C, white: 0xFFFFFF
});
const PLAYER_BOUNDS = 18;
const PLAYER_RADIUS = 0.42;
const TOP_SPEED = 5.0;
const INTERACTION_DISTANCE = 2.25;
const STUDIO_POINT = new THREE.Vector3(-16.3, 0, -9.7);
const SHOP_POINT = new THREE.Vector3(15.5, 0, 9.0);
const TITLE_CAMERA = new THREE.Vector3(17, 19, 23);
const CAMERA_OFFSET = new THREE.Vector3(9, 11, 9);
const BAG_CAPACITY = [0, 6, 8, 10];
const BAG_COST = [0, 0, 40, 80];
const SHOP_COST = [0, 0, 60, 120];
const SHOP_BONUS = [0, 0, 5, 10];
const STOCKROOM_CAPACITY = 8;
const STARTING_TIME = 90;
const MAX_ARCADE_TIME = 180;
const PICKUP_RADIUS = 1.6;
const RARITY_RANK = Object.freeze({ EVERYDAY:0, CUTE:1, FABULOUS:2, LEGENDARY:3 });
const RECIPE_VALUES = Object.freeze({
  garmentType:['TOP','DRESS','SKIRT'],
  colour:['LAVENDER','MINT','PEACH','SKY'],
  motif:['STAR','HEART','FLOWER'],
  trim:['BOW','BELT','RUFFLE']
});
const ALL_RECIPES = Object.freeze(RECIPE_VALUES.garmentType.flatMap(garmentType =>
  RECIPE_VALUES.colour.flatMap(colour => RECIPE_VALUES.motif.flatMap(motif =>
    RECIPE_VALUES.trim.map(trim => Object.freeze({ garmentType, colour, motif, trim }))
  ))
));
const DISTRICTS = [
  { id:'laundry', name:'Clothesline Lane', short:'LAUNDRY', center:[-10,-11], destination:[-6,-13], colour:C.peach },
  { id:'carnival', name:'Sticker Carnival', short:'CARNIVAL', center:[11,-11], destination:[6,-13], colour:C.yellow },
  { id:'disco', name:'Dye Disco', short:'DISCO', center:[14,-2], destination:[15,6], colour:C.sky },
  { id:'runway', name:'Runway Arcade', short:'RUNWAY', center:[9,13], destination:[13,15], colour:C.coral },
  { id:'garden', name:'Ribbon Garden', short:'GARDEN', center:[-11,12], destination:[-6,14], colour:C.mint },
  { id:'ducks', name:'Duck Boardwalk', short:'DUCKS', center:[-14,5], destination:[-15,8], colour:C.lavender }
];
const SUPPLIERS = [
  { districtId:'laundry', category:'garments', start:[-12.4,-7], step:[2.4,0] },
  { districtId:'carnival', category:'motifs', start:[8.6,-7], step:[2.4,0] },
  { districtId:'disco', category:'dyes', start:[12,-4.5], step:[0,2.4] },
  { districtId:'runway', category:'garments', start:[5.4,11], step:[2.4,0] },
  { districtId:'runway', category:'trims', start:[5.4,15], step:[2.4,0] },
  { districtId:'garden', category:'trims', start:[-12,7], step:[2.4,0] },
  { districtId:'ducks', category:'dyes', start:[-12,-4.5], step:[0,2.4] },
  { districtId:'ducks', category:'motifs', start:[-15,-4.5], step:[0,2.4] }
];
const CATEGORY_RECIPE_KEY = { garments:'garmentType', dyes:'colour', motifs:'motif', trims:'trim' };
const COMPONENT_DEFINITIONS = SUPPLIERS.flatMap(supplier =>
  RECIPE_VALUES[CATEGORY_RECIPE_KEY[supplier.category]].map((type,index) => ({
    category:supplier.category, type, districtId:supplier.districtId,
    landmark:DISTRICTS.find(district => district.id === supplier.districtId).name,
    home:[supplier.start[0]+index*supplier.step[0], supplier.start[1]+index*supplier.step[1]]
  }))
);
const CRAFTING_COUNTERS = [
  { id:'studio', name:'Design Studio', point:STUDIO_POINT },
  { id:'east', name:'Disco Design Counter', point:new THREE.Vector3(15,0,3.5) },
  { id:'south', name:'Runway Design Counter', point:new THREE.Vector3(0,0,13) }
];
const TOWN_ROUTES = [
  [[-15,-13],[0,-13],[15,-13],[15,8],[15,16],[0,16],[-15,16],[-15,8],[-17,0],[-17,-13],[-15,-13]],
  [[-15,-5],[-5,-5],[5,-5],[15,-5]],
  [[-15,5],[-5,5],[5,5],[15,5]],
  [[-5,-13],[-5,5],[-5,16]],
  [[5,-13],[5,5],[5,16]]
];
const JUMP_SHORTCUTS = [
  {from:[-5,-6],to:[-2,-12],point:[-3.5,-9],rotation:Math.atan2(3,-6)},
  {from:[5,5],to:[11,7],point:[8,6],rotation:Math.atan2(6,2)},
  {from:[-5,8],to:[0,13],point:[-2.5,10.5],rotation:Math.PI/4}
];
// The original corridor reservations keep all unaffected supplier slots stable.
const STUNT_LANES=Object.freeze([
  {id:'R1',entry:[-5.5,-5],pad:[-5,-6],hurdle:[-4,-8],exit:[-1.5,-13],direction:[1/Math.sqrt(5),-2/Math.sqrt(5)]},
  {id:'R2',entry:[5.2,5+.2/3],pad:[6.2,5.4],hurdle:[8,6],exit:[11,7],direction:[3/Math.sqrt(10),1/Math.sqrt(10)]},
  {id:'R3',entry:[-6.5,6.5],pad:[-5.5,7.5],hurdle:[-3.5,9.5],exit:[-2,11],direction:[1/Math.sqrt(2),1/Math.sqrt(2)]}
].map(lane=>Object.freeze({...lane,hoop:Object.freeze([lane.hurdle[0]+lane.direction[0]*1.35,lane.hurdle[1]+lane.direction[1]*1.35])})));
const CUSTOMER_DEFINITIONS = [
  { id:'mia', name:'Mia', portrait:{skin:'#C77D52',hair:'#6B352F',shirt:'#FFD84A'}, model:'assets/third_party/kenney-mini-characters/Models/GLB%20format/character-female-b.glb', height:1.57, route:[[-5,0],[-3,4],[2,5],[5,1],[3,-4],[-2,-5]] },
  { id:'zoe', name:'Zoe', portrait:{skin:'#9B5C43',hair:'#29213D',shirt:'#54DDD0'}, model:'assets/third_party/kenney-mini-characters/Models/GLB%20format/character-female-c.glb', height:1.60, route:[[5,0],[10,0],[14,3],[14,7],[10,9],[6,6]] },
  { id:'ava', name:'Ava', portrait:{skin:'#E5A271',hair:'#D86C3A',shirt:'#7B4DFF'}, model:'assets/third_party/kenney-mini-characters/Models/GLB%20format/character-female-d.glb', height:1.55, route:[[-5,0],[-10,0],[-14,3],[-14,7],[-10,9],[-6,6]] },
  { id:'noah', name:'Noah', portrait:{skin:'#8E593E',hair:'#242036',shirt:'#FF9877'}, model:'assets/third_party/kenney-mini-characters/Models/GLB%20format/character-male-a.glb', height:1.62, route:[[0,-5],[0,-10],[4,-13],[9,-11],[10,-7],[6,-5]] },
  { id:'leo', name:'Leo', portrait:{skin:'#E3A06F',hair:'#8A4A2F',shirt:'#70CFFF'}, model:'assets/third_party/kenney-mini-characters/Models/GLB%20format/character-male-b.glb', height:1.59, route:[[0,-5],[0,-10],[-4,-13],[-9,-11],[-10,-7],[-6,-5]] }
];
const CUSTOMER_PAUSES = [.8, 1, 1.2, 1.4, 1.1];
const freezeTags = values => Object.freeze(Object.fromEntries(Object.entries(values).map(([key,tags])=>[key,Object.freeze(tags)])));
const FASHION_TRAIT_RULES=Object.freeze(Object.fromEntries(Object.entries({
  SWEET:[['HEART','BOW'],['SKIRT','PUFFY'],['FLOWER','BOW'],['HEART','PUFFY']],
  EDGY:[['STAR','ASYMMETRIC'],['TOP','BELT'],['BELT','ASYMMETRIC'],['TOP','STAR']],
  CHIC:[['DRESS','CLASSIC'],['BELT','CLASSIC'],['FLOWER','BELT'],['DRESS','FLOWER']],
  PLAYFUL:[['SKIRT','RUFFLE'],['PUFFY','STAR'],['TOP','PUFFY'],['STAR','RUFFLE']],
  ROMANTIC:[['FLOWER','RUFFLE'],['DRESS','PUFFY'],['HEART','LAYERED'],['DRESS','HEART']],
  DRAMATIC:[['STAR','LAYERED'],['DRESS','ASYMMETRIC'],['RUFFLE','ASYMMETRIC'],['LAYERED','BELT']]
}).map(([trait,rules])=>[trait,Object.freeze(rules.map(pair=>Object.freeze(pair)))])));
const unorderedPairKey=(a,b)=>[a,b].sort().join('|');
const PALETTE_MOOD_RULES=freezeTags({
  'LAVENDER|PEACH':['DREAMY','WARM'],'LAVENDER|SKY':['DREAMY','COOL'],
  'LAVENDER|MINT':['FRESH','COOL'],'MINT|SKY':['FRESH','COOL'],
  'MINT|PEACH':['FRESH','WARM'],'PEACH|SKY':['DREAMY','WARM']
});
function deriveLookComposition(design){
  const choices=new Set([design.garmentType,design.motif,design.trim,design.cutVariant].filter(Boolean));
  const traitReasons=Object.fromEntries(Object.entries(FASHION_TRAIT_RULES).map(([trait,rules])=>[trait,rules.filter(pair=>pair.every(choice=>choices.has(choice))).map(pair=>[...pair])]).filter(([,rules])=>rules.length));
  const paletteMoods=design.colour&&design.accentColour&&design.colour!==design.accentColour?[...(PALETTE_MOOD_RULES[unorderedPairKey(design.colour,design.accentColour)]||[])]:[];
  return {fashionTraits:Object.keys(traitReasons),traitReasons,paletteMoods};
}
const CUSTOMER_STYLE_PROFILES=Object.freeze(Object.fromEntries(Object.entries({
  mia:['CHIC','DREAMY'],zoe:['PLAYFUL','FRESH'],ava:['ROMANTIC','DREAMY'],noah:['CHIC','WARM'],leo:['DRAMATIC','COOL'],
  pippa:['SWEET','WARM'],jett:['EDGY','COOL'],bea:['ROMANTIC','FRESH'],otto:['PLAYFUL','COOL'],cleo:['DRAMATIC','WARM']
}).map(([id,[styleTag,paletteTag]])=>[id,Object.freeze({styleTag,paletteTag})])));
const BRIEF_REWARDS=Object.freeze([0,600,1000,1300]);
const BRIEF_RARITY_BOOST=Object.freeze([0,.02,.05,.08]);
function calculateBriefFit(design,customerId) {
  const profile=CUSTOMER_STYLE_PROFILES[customerId],customer=CUSTOMER_DEFINITIONS.find(c=>c.id===customerId);
  const composition=deriveLookComposition(design),styleMatch=composition.fashionTraits.includes(profile?.styleTag),paletteMatch=composition.paletteMoods.includes(profile?.paletteTag);
  const styleMatches=(composition.traitReasons[profile?.styleTag]||[]).map(pair=>pair.join(' + '));
  const paletteMatches=paletteMatch?[`${design.colour} + ${design.accentColour}`]:[];
  const touchMatches=Object.entries(customer?.preference||{}).filter(([key,value])=>design[key]===value).map(([,value])=>value);
  return {...composition,styleMatch,paletteMatch,briefFit:(styleMatch?2:0)+(paletteMatch?1:0),personalTouches:touchMatches.length,styleMatches,paletteMatches,touchMatches};
}
function briefVerdict(fit){return ['NOT MY VIBE',"IT'S OKAY",'LOVE IT','NAILED IT!'][fit]||'NOT MY VIBE';}
function customerStyleText(customerId) {
  const profile=CUSTOMER_STYLE_PROFILES[customerId];return profile?`${profile.styleTag} · ${profile.paletteTag}`:'';
}
function personalTouchText(customerId){const customer=CUSTOMER_DEFINITIONS.find(c=>c.id===customerId);return Object.values(customer?.preference||{}).join(' · ');}
function briefMarkup(customerId){const touches=personalTouchText(customerId);return `<span class="customer-style">${customerStyleText(customerId)}</span>${touches?`<small class="personal-preferences">LOVES · ${touches} <em>optional</em></small>`:''}`;}
const MATERIAL_CATEGORIES=Object.freeze(['garments','dyes','motifs','trims']);
const CATEGORY_LABELS=Object.freeze({garments:'GARMENT',dyes:'DYE',motifs:'MOTIF',trims:'TRIM'});
function readyCategoryCount(){return MATERIAL_CATEGORIES.filter(category=>categoryTotal(category)>0).length;}
function teachingCollection(){return gameState.practice||gameState.stats.sales===0;}
function detailedMaterialGuidance(){return teachingCollection()||gameState.guideRemaining>0;}
function activateGuide(){if(simulationSuspended()||!gameState.started||gameState.gameOver||gameState.modalOpen||saleGameplayPaused())return;gameState.guideRemaining=10;selectedPickup=null;navigationRoute=null;toast('GUIDE · 10 SECONDS');updateHUD();}
const EXTRA_CUSTOMERS = [
  { id:'pippa', name:'Pippa', role:'baker', base:'mia', preference:{colour:'PEACH',motif:'HEART'}, line:'Fresh looks! Hot off the runway!', colour:C.peach },
  { id:'jett', name:'Jett', role:'skater', base:'noah', preference:{garmentType:'TOP',motif:'STAR'}, line:'That look deserves a victory lap!', colour:C.sky },
  { id:'bea', name:'Bea', role:'florist', base:'ava', preference:{colour:'MINT',motif:'FLOWER'}, line:'Blooming brilliant! Petal to the metal!', colour:C.mint },
  { id:'otto', name:'Otto', role:'duck keeper', base:'leo', preference:{garmentType:'TOP',motif:'HEART'}, line:'The ducks approve. That is high praise!', colour:C.yellow },
  { id:'cleo', name:'Cleo', role:'carnival host', base:'zoe', preference:{garmentType:'SKIRT',motif:'STAR'}, line:'Step right up! A spectacular look!', colour:C.coral }
];
for (const definition of EXTRA_CUSTOMERS) {
  const base = CUSTOMER_DEFINITIONS.find(customer => customer.id === definition.base);
  CUSTOMER_DEFINITIONS.push({ ...base, ...definition, portrait:{...base.portrait,shirt:`#${definition.colour.toString(16).padStart(6,'0')}`} });
}
CUSTOMER_DEFINITIONS.forEach((customer,index) => {
  customer.styleProfile=CUSTOMER_STYLE_PROFILES[customer.id];
  const district = DISTRICTS[index % DISTRICTS.length];
  const next = DISTRICTS[(index+1) % DISTRICTS.length];
  const offset=index>=6 ? .9 : 0;
  customer.route = [[district.destination[0]+offset,district.destination[1]], [district.destination[0]+offset,5], [next.destination[0]+offset,5], [next.destination[0]+offset,next.destination[1]]];
});

// 3. gameState
const gameState = {
  practice:false, practiceOffer:null, practiceFinishing:false, started: false, coins: 0, inventory: createEmptyInventory(), bagLevel: 1, bagCapacity: 6,
  stockroom: createEmptyInventory(), showcase: [], showcaseSequence: 0, shopTab: 'orders',
  shopLevel: 1, hasFinishedDesign: false, designRejected:false,
  selectedGarmentType: 'DRESS', selectedColour: 'LAVENDER', selectedMotif: 'STAR', selectedTrim: 'BOW', selectedCut:'CLASSIC', selectedAccent:'MINT', workerOwned: false,
  rareNextSale: false, speedBoostUntil: 0, runwayRushUntil:0, activePlayTime:0, guideRemaining:0, shopObjective:false, collectionReminderShown:false, modalOpen: null, soundEnabled: true,
  recipeDeck:[], recipeIndex:0, runSeed:0, rngState:0, orderOffers:[], activeOrder:null, previousCustomerId:null, nextOffersAt:0,
  destinationPool:[], previousDestinationId:null,
  finishedDesign: null, timeRemaining:STARTING_TIME, timerStarted:false,
  score:0, streak:0, bestCombo:0, gameOver:false,
  stats:{ sales:0, perfectMatches:0, legendaryDesigns:0, customersAnnoyed:0 }
};

function createEmptyInventory() {
  return {
    garments:{ TOP:0, DRESS:0, SKIRT:0 },
    dyes:{ LAVENDER:0, MINT:0, PEACH:0, SKY:0 },
    motifs:{ STAR:0, HEART:0, FLOWER:0 },
    trims:{ BOW:0, BELT:0, RUFFLE:0 }
  };
}
function categoryTotal(category) { return Object.values(gameState.inventory[category]).reduce((sum, count) => sum + count, 0); }
function totalMaterials() { return ['garments','dyes','motifs','trims'].reduce((sum, category) => sum + categoryTotal(category), 0); }
function hasCraftingSet() { return ['garments','dyes','motifs','trims'].every(category => categoryTotal(category) > 0); }

function createRunSeed() {
  if (globalThis.crypto?.getRandomValues) return crypto.getRandomValues(new Uint32Array(1))[0] || 1;
  return (Date.now() ^ Math.floor(gameNow() * 1000)) >>> 0 || 1;
}
function runRandom() {
  gameState.rngState = (gameState.rngState + 0x6D2B79F5) >>> 0;
  let value = gameState.rngState;
  value = Math.imul(value ^ value >>> 15, value | 1);
  value ^= value + Math.imul(value ^ value >>> 7, value | 61);
  return ((value ^ value >>> 14) >>> 0) / 4294967296;
}
function shuffleWithRunRandom(values) {
  for (let index = values.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(runRandom() * (index + 1));
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
}
function reshuffleRecipeDeck() {
  gameState.recipeDeck = shuffleWithRunRandom(ALL_RECIPES.map(recipe => ({ ...recipe })));
  gameState.recipeIndex = 0;
}
function drawRecipe() {
  if (gameState.recipeIndex >= gameState.recipeDeck.length) reshuffleRecipeDeck();
  return gameState.recipeDeck[gameState.recipeIndex++];
}
function drawCustomerRecipe(customer) {
  if(gameState.recipeIndex>=gameState.recipeDeck.length) reshuffleRecipeDeck();
  if(customer.preference&&runRandom()<.6) {
    const index=gameState.recipeDeck.findIndex((recipe,index)=>index>=gameState.recipeIndex&&Object.entries(customer.preference).every(([key,value])=>recipe[key]===value));
    if(index>=0) [gameState.recipeDeck[index],gameState.recipeDeck[gameState.recipeIndex]]=[gameState.recipeDeck[gameState.recipeIndex],gameState.recipeDeck[index]];
  }
  return drawRecipe();
}
function recipeComponents(recipe) {
  if (!recipe) return [];
  return [
    ['garments',recipe.garmentType], ['dyes',recipe.colour],
    ['motifs',recipe.motif], ['trims',recipe.trim]
  ];
}
function recipeOwnedCount(recipe) {
  return recipeComponents(recipe).filter(([category,type]) => gameState.inventory[category][type] > 0).length;
}
function hasActiveOrderMaterials() { return Boolean(gameState.activeOrder)&&hasCraftingSet(); }
function offerForCustomer(customerId) { return gameState.orderOffers.find(offer => offer.customerId === customerId); }
function generateOrderOffers() {
  if (!gameState.started || gameState.gameOver || gameState.activeOrder) return;
  const eligible = customers.filter(customer => customer.id !== gameState.previousCustomerId&&!customer.resumeAt&&!customer.fumingUntil);
  shuffleWithRunRandom(eligible);
  if(gameState.destinationPool.length<3) gameState.destinationPool=shuffleWithRunRandom(DISTRICTS.map(item=>item.id).filter(id=>id!==gameState.previousDestinationId));
  const routeLengths=new Map(gameState.destinationPool.map(id=>[id,estimateOrderRouteLength(null,id)]));
  const candidates=eligible.slice(0,6).flatMap(customer=>{
    return gameState.destinationPool.map(destinationId=>({customerId:customer.id,destinationId,routeLength:routeLengths.get(destinationId)}));
  }).sort((a,b)=>a.routeLength-b.routeLength);
  const chosen=[];
  for(const fraction of [0,1,.5]) {
    const available=candidates.filter(item=>!chosen.some(other=>other.customerId===item.customerId||other.destinationId===item.destinationId));
    const offer=available[Math.round((available.length-1)*fraction)];
    if(offer)chosen.push(offer);
  }
  gameState.orderOffers=chosen.sort((a,b)=>a.routeLength-b.routeLength).map((offer,index)=>{
    const difficulty=['EASY','MEDIUM','HARD'][index], difficultyMultiplier=[1,1.5,2][index];
    return {...offer,difficulty,difficultyMultiplier,difficultyClass:difficulty.toLowerCase(),estimatedTravelSeconds:Math.ceil(offer.routeLength/TOP_SPEED),deadlineSeconds:deadlineForDifficulty(Math.ceil(offer.routeLength/TOP_SPEED),difficulty)};
  });
  gameState.nextOffersAt = 0;
  customers.forEach(refreshCustomerBubble);
  updateHUD();
  renderShop();
  renderOrderBoard();
  if(!gameState.practice)openModal('orders');
}
function acceptOrder(offer) {
  if (!offer || !gameState.orderOffers.includes(offer) || gameState.activeOrder || gameState.gameOver) return;
  const destination=DISTRICTS.find(item=>item.id===offer.destinationId);
  gameState.activeOrder = {
    customerId:offer.customerId, difficulty:offer.difficulty,
    // styleTips is the existing traversal/collection Hustle Bonus, separate from fashion Style Fit.
    difficultyMultiplier:offer.difficultyMultiplier, elapsedTravelTime:0, styleTips:0, rewardedMaterials:[],
    estimatedTravelSeconds:offer.estimatedTravelSeconds,
    pickupChain:0, pickupChainExpiresAt:0, orderLate:false, styleHopCount:0, lastStyleHopAt:-Infinity,
    destinationId:offer.destinationId, deadlineSeconds:offer.deadlineSeconds??estimateOrderDeadline(null,offer.destinationId,offer.difficulty), rewardedGates:[]
  };
  Object.assign(gameState.activeOrder,{draftDesignSeed:null,designerCategory:'garment',collectionProgressAt:gameState.activePlayTime,collectionPulseShown:false});
  gameState.guideRemaining=0;gameState.shopObjective=false;
  document.querySelectorAll('.supplier-pulse').forEach(marker=>marker.classList.remove('supplier-pulse'));
  const remindCollection=!teachingCollection()&&!gameState.collectionReminderShown;
  if(remindCollection)gameState.collectionReminderShown=true;
  gameState.destinationPool=gameState.destinationPool.filter(id=>id!==offer.destinationId);
  const customer=customers.find(item=>item.id===offer.customerId);
  customer.deliveryPath=walkingPath(customer.wrapper.position,destination.destination).slice(1);
  customer.deliveryIndex=0; customer.atDestination=false; customer.pausedUntil=0;
  gameState.orderOffers = [];
  gameState.nextOffersAt = 0;
  customers.forEach(refreshCustomerBubble);
  renderShop();
  if (gameState.modalOpen === 'shop') closeModal('shop');
  if (gameState.modalOpen === 'orders') closeModal('orders');
  selectedPickup=null;selectedCounter=null;navigationRoute=null;
  playSound('pickup');
  toast(remindCollection?`YOU'RE THE DESIGNER NOW\nChoose one garment, dye, motif and trim.\n${touchDevice?'Tap INTERACT':'Press E'} to take what you want.`:`DELIVER TO ${destination.short}`);
  showCustomerSpeech(customer,`Meet me at ${destination.name}!`,1600);
  updateHUD();
}

// 4. renderer/scene/camera
const canvas = document.querySelector('#game-canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, touchDevice ? 1 : 1.5));
renderer.setSize(gameViewport.width, gameViewport.height);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.16;
const labelRenderer = new CSS2DRenderer();
labelRenderer.setSize(gameViewport.width, gameViewport.height);
labelRenderer.domElement.className = 'world-label-layer';
labelRenderer.domElement.style.pointerEvents = 'none';
document.body.appendChild(labelRenderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(C.sky);
scene.fog = new THREE.Fog(0xBDE8FF, 42, 78);
const camera = new THREE.PerspectiveCamera(42, gameViewport.width / gameViewport.height, 0.1, 120);
camera.position.copy(TITLE_CAMERA);
const clock = new THREE.Clock();
const cameraTarget = new THREE.Vector3(0, 1, 0);
const titleStartCamera = new THREE.Vector3();
let titleTransitionElapsed = 0;
let elapsed = 0;

// 5. reusable materials/geometries
const mat = (colour, options = {}) => new THREE.MeshStandardMaterial({
  color: colour, roughness: options.roughness ?? 0.72, metalness: 0,
  transparent: options.transparent ?? false, opacity: options.opacity ?? 1,
  emissive: options.emissive ?? 0x000000, emissiveIntensity: options.emissiveIntensity ?? 0,
  side: options.side ?? THREE.FrontSide
});
const materials = {
  lavender: mat(C.lavender), mint: mat(C.mint), peach: mat(C.peach), sky: mat(C.sky),
  yellow: mat(C.yellow), coral: mat(C.coral), cream: mat(C.cream), grass: mat(C.grass),
  path: mat(C.path), pathEdge: mat(C.pathEdge), ink: mat(0x514A68), gold: mat(C.gold, { roughness: .45 }),
  brown: mat(C.brown), leaf: mat(C.leaf), white: mat(C.white), darkMint: mat(C.darkMint),
  glass: mat(0xA9E8FF, { transparent: true, opacity: .72, roughness: .22 })
};
const box = new THREE.BoxGeometry(1, 1, 1);
const cylinder = new THREE.CylinderGeometry(1, 1, 1, 12);
const sphere = new THREE.SphereGeometry(1, 16, 12);
const dodeca = new THREE.DodecahedronGeometry(1, 0);
const sharedGeometries=new Set([box,cylinder,sphere,dodeca]);
const sharedMaterials=new Set(Object.values(materials));
function disposeGeneratedGroup(group) {
  const geometries=new Set(),ownedMaterials=new Set();
  group.traverse(child=>{
    for(const material of child.userData.ownedGarmentMaterials||[])ownedMaterials.add(material);
    if(child.isCSS2DObject)child.element.remove();
    if(child.geometry&&!sharedGeometries.has(child.geometry))geometries.add(child.geometry);
    for(const material of child.material?(Array.isArray(child.material)?child.material:[child.material]):[])if(!sharedMaterials.has(material))ownedMaterials.add(material);
  });
  geometries.forEach(geometry=>geometry.dispose());ownedMaterials.forEach(material=>material.dispose());
}
function disposeOwnedCharacter(group) {
  const textures=new Set(),skeletons=new Set();
  group.traverse(child=>{
    if(child.skeleton)skeletons.add(child.skeleton);
    for(const material of child.material?(Array.isArray(child.material)?child.material:[child.material]):[])
      for(const value of Object.values(material))if(value?.isTexture)textures.add(value);
  });
  disposeGeneratedGroup(group);textures.forEach(texture=>texture.dispose());skeletons.forEach(skeleton=>skeleton.dispose());
}
function batchStaticWorldMeshes() {
  // Small spatial batches reduce the hundreds of repeated primitive draw calls
  // while retaining culling, original transforms, animation and shared resources.
  const moving=new Set([
    ...clouds.map(item=>item.group),...swayingProps.map(item=>item.object),
    ...townDucks.map(item=>item.duck),...butterflies.map(item=>item.g),
    ...fountainJets.map(item=>item.orb),...fountainSparkles.map(item=>item.mesh),
    ...discoLights,...jumpGates.map(item=>item.visual),objectiveMarker
  ]);
  scene.updateMatrixWorld(true);const batches=new Map(),position=new THREE.Vector3();
  scene.traverse(item=>{
    if(!item.isMesh||item.children.length||!sharedGeometries.has(item.geometry)||!sharedMaterials.has(item.material)||item.material.transparent)return;
    for(let parent=item;parent;parent=parent.parent)if(moving.has(parent))return;
    item.getWorldPosition(position);
    const key=`${item.geometry.uuid}:${item.material.uuid}:${item.castShadow}:${item.receiveShadow}:${Math.floor(position.x/12)}:${Math.floor(position.z/12)}`;
    if(!batches.has(key))batches.set(key,[]);batches.get(key).push(item);
  });
  for(const meshes of batches.values()){
    if(meshes.length<3)continue;
    const first=meshes[0],batch=new THREE.InstancedMesh(first.geometry,first.material,meshes.length);
    batch.castShadow=first.castShadow;batch.receiveShadow=first.receiveShadow;
    meshes.forEach((item,index)=>{batch.setMatrixAt(index,item.matrixWorld);item.visible=false;});
    batch.computeBoundingSphere();scene.add(batch);
  }
}
let requiredAssetFailed=false;
const assetManager=new THREE.LoadingManager();
assetManager.onError=()=>{requiredAssetFailed=true;};
const loader = new GLTFLoader(assetManager);
const natureAssets = {};
const natureFiles = ['tree_default','tree_oak','rock_smallA','sign','fence_simple','fence_gate'];

async function loadNatureAssets() {
  const base = 'assets/third_party/kenney-nature-kit/Models/GLTF%20format/';
  await Promise.all(natureFiles.map(async name => {
    const gltf = await loader.loadAsync(`${base}${name}.glb`);
    gltf.scene.traverse(child => {
      if (!child.isMesh) return;
      child.castShadow = true;
      child.receiveShadow = true;
      const childMaterials = Array.isArray(child.material) ? child.material : [child.material];
      childMaterials.forEach(material => { if (material?.map) material.map.colorSpace = THREE.SRGBColorSpace; });
    });
    natureAssets[name] = gltf.scene;
  }));
}

function mesh(geometry, material, position, scale, parent = scene, shadows = true) {
  const item = new THREE.Mesh(geometry, material);
  item.position.set(...position);
  item.scale.set(...scale);
  item.castShadow = shadows;
  item.receiveShadow = shadows;
  parent.add(item);
  return item;
}

function groupAt(x, y, z, rotation = 0) {
  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.y = rotation;
  scene.add(group);
  return group;
}

function natureProp(name, parent, position, scale = 1, rotation = 0) {
  const anchor = new THREE.Group();
  const model = natureAssets[name].clone(true);
  const scaleVector = Array.isArray(scale) ? scale : [scale, scale, scale];
  model.scale.set(...scaleVector);
  model.rotation.y = rotation;
  model.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(model);
  model.position.y -= bounds.min.y;
  anchor.position.set(...position);
  anchor.add(model);
  parent.add(anchor);
  return anchor;
}

const clouds = [];
function createSky() {
  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      zenith: { value:new THREE.Color('#47BDF8') },
      upper: { value:new THREE.Color('#70CFFF') },
      horizon: { value:new THREE.Color('#FFF4DF') }
    },
    vertexShader: 'varying float vHeight;void main(){vHeight=normalize(position).y;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: 'uniform vec3 zenith;uniform vec3 upper;uniform vec3 horizon;varying float vHeight;void main(){float h=smoothstep(-0.12,0.28,vHeight);float z=smoothstep(0.22,0.92,vHeight);vec3 colour=mix(horizon,upper,h);colour=mix(colour,zenith,z);gl_FragColor=vec4(colour,1.0);}'
  });
  mesh(new THREE.SphereGeometry(80,48,28),skyMaterial,[0,0,0],[1,1,1],scene,false);
  const sunCanvas=document.createElement('canvas'); sunCanvas.width=sunCanvas.height=128;
  const context=sunCanvas.getContext('2d'); const glow=context.createRadialGradient(64,64,8,64,64,62);
  glow.addColorStop(0,'rgba(255,242,168,1)'); glow.addColorStop(.48,'rgba(255,242,168,.92)'); glow.addColorStop(1,'rgba(255,242,168,0)');
  context.fillStyle=glow; context.fillRect(0,0,128,128);
  const sunTexture=new THREE.CanvasTexture(sunCanvas); sunTexture.colorSpace=THREE.SRGBColorSpace;
  const sunDisc=new THREE.Sprite(new THREE.SpriteMaterial({map:sunTexture,transparent:true,depthWrite:false,fog:false}));
  sunDisc.position.set(-32,35,-42); sunDisc.scale.set(10,10,1); scene.add(sunDisc);
  const layouts=[[-35,16,-24,.20,3,.84],[-23,18,-7,.24,4,.88],[-10,14.8,15,.19,5,.86],[3,17.5,-30,.28,4,.92],[15,15.7,25,.22,3,.82],[27,18.8,6,.30,5,.89],[36,14.3,-12,.18,4,.87],[-4,19,32,.26,3,.90]];
  layouts.forEach(([x,y,z,speed,count,opacity],cloudIndex)=>{
    const cloud=new THREE.Group(); cloud.position.set(x,y,z);
    const cloudMaterial=new THREE.MeshBasicMaterial({color:0xFFFFFF,transparent:true,opacity,depthWrite:false,fog:false});
    for(let puffIndex=0;puffIndex<count;puffIndex++){
      const offset=puffIndex-(count-1)/2;
      const puff=mesh(new THREE.SphereGeometry(1,12,8),cloudMaterial,[offset*1.25,Math.sin(puffIndex*1.7)*.35,Math.cos(puffIndex*1.3)*.25],[1.25+(puffIndex%2)*.32,.72+(puffIndex%3)*.12,.78],cloud,false);
      puff.rotation.y=cloudIndex*.31+puffIndex;
    }
    scene.add(cloud); clouds.push({group:cloud,speed});
  });
}

function updateClouds(dt) {
  clouds.forEach(cloud=>{cloud.group.position.x+=cloud.speed*dt;if(cloud.group.position.x>42)cloud.group.position.x=-42;});
}

// 6. Character and environment assets are loaded from the local Kenney directories.

// 7. procedural helper functions
function worldLabel(text) {
  const element = document.createElement('div');
  element.className = 'world-label';
  element.textContent = text;
  const label = new CSS2DObject(element);
  readableLabels.push(label);
  return label;
}

function createStripedAwning(parent, z, colourMaterial, y = 2.55) {
  const awning = new THREE.Group();
  awning.position.set(0, y, z);
  for (let i = 0; i < 7; i++) {
    const stripe = mesh(box, i % 2 ? materials.cream : colourMaterial, [-1.5 + i * .5, 0, 0], [.49, .16, .9], awning);
    stripe.rotation.x = -.13;
  }
  parent.add(awning);
}

function createPlanter(parent, x, z, flowerColour = materials.peach) {
  mesh(box, materials.cream, [x, .34, z], [1.35, .5, .55], parent);
  for (let i = -1; i <= 1; i++) {
    mesh(sphere, flowerColour, [x + i * .34, .72 + Math.abs(i) * .03, z], [.17, .17, .17], parent);
    mesh(cylinder, materials.leaf, [x + i * .34, .57, z], [.035, .26, .035], parent);
  }
}

function createFlowerCluster(x, z, parent = scene) {
  const group = new THREE.Group();
  group.position.set(x, 0, z);
  const petalMats = [materials.peach, materials.lavender, materials.sky, materials.coral];
  for (let f = 0; f < 5; f++) {
    const a = f * 2.399;
    const r = .16 + (f % 2) * .18;
    const fx = Math.cos(a) * r;
    const fz = Math.sin(a) * r;
    const h = .3 + (f % 3) * .07;
    mesh(cylinder, materials.leaf, [fx, h / 2, fz], [.018, h, .018], group, false);
    mesh(sphere, materials.yellow, [fx, h, fz], [.055, .04, .055], group, false);
    for (let p = 0; p < 5; p++) {
      const pa = p * Math.PI * .4;
      mesh(sphere, petalMats[f % 4], [fx + Math.cos(pa) * .075, h, fz + Math.sin(pa) * .075], [.055, .025, .04], group, false);
    }
  }
  parent.add(group);
  return group;
}

function createTree(x, z, large = false) {
  const group = groupAt(x, 0, z);
  const size = large ? 1.18 : .88;
  mesh(cylinder, materials.brown, [0, 1.05 * size, 0], [.22 * size, 2.1 * size, .22 * size], group);
  const canopy = mesh(dodeca, materials.leaf, [0, 2.65 * size, 0], [1.18 * size, 1.05 * size, 1.18 * size], group);
  canopy.rotation.y = x;
  mesh(dodeca, mat(0x8BC79A), [.55 * size, 2.35 * size, .1], [.65 * size, .62 * size, .65 * size], group);
  treeBlockers.push({ x, z, radius: .65 });
  return group;
}

function createFence(x, z, rotation, length = 4.5) {
  const group = groupAt(x, 0, z, rotation);
  for (let i = -length / 2; i <= length / 2; i += 1.5) {
    mesh(box, materials.cream, [i, .58, 0], [.14, 1.16, .14], group);
    mesh(sphere, materials.cream, [i, 1.18, 0], [.12, .12, .12], group);
  }
  mesh(box, materials.cream, [0, .45, 0], [length + .2, .13, .13], group);
  mesh(box, materials.cream, [0, .85, 0], [length + .2, .13, .13], group);
}

function createBench(x, z) {
  const g = groupAt(x, 0, z, -.25);
  mesh(box, materials.cream, [-.85, .34, 0], [.15, .68, .7], g);
  mesh(box, materials.cream, [.85, .34, 0], [.15, .68, .7], g);
  mesh(box, mat(0xD7A77B), [0, .66, 0], [2.15, .22, .75], g);
  mesh(box, mat(0xE4B98D), [0, 1.18, .31], [2.15, .72, .18], g);
  solidFootprints.push({x,z,width:2.15,depth:1,rotation:-.25});
}

const fountainJets = [];
const swayingProps = [];
const townDucks = [];
const butterflies = [];
const fountainSparkles = [];

function signAt(text, x, z, y = 1.55) {
  const anchor = new THREE.Group();
  anchor.position.set(x, y, z);
  anchor.add(worldLabel(text));
  scene.add(anchor);
}

function starShape(outer = 1, inner = .46) {
  const shape = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const radius = i % 2 ? inner : outer;
    const angle = -Math.PI / 2 + i * Math.PI / 5;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  shape.closePath();
  return shape;
}

function createBunting(parent, start, count, colourMats) {
  mesh(cylinder, materials.cream, [start[0] + (count - 1) * .28, start[1] + .18, start[2]], [.015, count * .58, .015], parent, false).rotation.z = Math.PI / 2;
  for (let i = 0; i < count; i++) {
    const flag = mesh(new THREE.ConeGeometry(.16, .38, 3), colourMats[i % colourMats.length], [start[0] + i * .56, start[1], start[2]], [1, 1, .35], parent, false);
    flag.rotation.z = Math.PI;
  }
}

function createFashionFountain() {
  mesh(new THREE.CylinderGeometry(2.15, 2.15, .32, 64), materials.cream, [0, .16, 0], [1, 1, 1]);
  mesh(new THREE.CylinderGeometry(1.86, 1.86, .19, 64), materials.sky, [0, .34, 0], [1, 1, 1]);
  const water = mesh(new THREE.CylinderGeometry(1.65, 1.65, .05, 64), mat(C.sky, { transparent:true, opacity:.72, roughness:.2 }), [0, .47, 0], [1, 1, 1], scene, false);
  water.material.depthWrite = false;
  mesh(cylinder, materials.cream, [0, .95, 0], [.28, 1.2, .28]);
  const star = mesh(new THREE.ExtrudeGeometry(starShape(.72, .34), { depth:.18, bevelEnabled:true, bevelSize:.04, bevelThickness:.04, bevelSegments:2 }), materials.yellow, [0, 1.48, -.09], [1, 1, 1]);
  star.rotation.y = -.1;
  for (let jet = 0; jet < 4; jet++) {
    const angle = jet * Math.PI / 2;
    for (let drop = 0; drop < 4; drop++) {
      const orb = mesh(sphere, materials.glass, [0, .65, 0], [.085, .085, .085], scene, false);
      fountainJets.push({ orb, angle, phase: drop / 4 });
    }
  }
  treeBlockers.push({ x:0, z:0, radius:2.35 });
  [[-3.25,-3.25],[3.25,-3.25],[-3.25,3.25],[3.25,3.25]].forEach(([x,z], i) => createPlanter(scene, x, z, [materials.peach,materials.lavender,materials.sky,materials.yellow][i]));
  natureProp('rock_smallA',scene,[-4,.02,1.55],1.35,.4); natureProp('rock_smallA',scene,[3.9,.02,1.65],1.05,-.7);
  natureProp('tree_default',scene,[-4.3,0,4.45],1.18,.25); natureProp('tree_oak',scene,[4.3,0,4.55],1.05,-.4);
  treeBlockers.push({x:-4.3,z:4.45,radius:.52},{x:4.3,z:4.55,radius:.58});
  for(let index=0;index<10;index++){
    const sparkle=mesh(new THREE.OctahedronGeometry(.055),materials.cream,[0,.52,0],[1,1,1],scene,false);
    fountainSparkles.push({mesh:sparkle,phase:index*.63,radius:.35+(index%4)*.33});
  }
  signAt('FASHION FOUNTAIN', 0, 2.25, 1.2);
}

function createGraphicSign(text, x, y, z, rotation = 0, colour = '#FFD84A', width = 4.2) {
  const group = groupAt(x, y, z, rotation);
  const board = mesh(new THREE.BoxGeometry(1, 1, 1), mat(C.ink), [0, .05, 0], [width + .22, 1.2, .18], group);
  board.castShadow = true;
  mesh(box, mat(Number(colour.replace('#','0x'))), [0,.05,0], [width,1,.2], group, false);
  const label = worldLabel(text); label.position.set(0,.9,0); group.add(label);
  mesh(cylinder, materials.ink, [-width * .34, -.78, 0], [.065, 1.05, .065], group);
  mesh(cylinder, materials.ink, [width * .34, -.78, 0], [.065, 1.05, .065], group);
  return group;
}

function createClotheslineLane() {
  const g = groupAt(-10, 0, -10);
  natureProp('fence_simple',g,[-1.25,0,1.72],1.25,0); natureProp('fence_simple',g,[1.25,0,1.72],1.25,0);
  for (const x of [-1.55, 1.55]) { mesh(cylinder, materials.cream, [x, 1.35, 0], [.09, 2.7, .09], g); mesh(sphere, materials.cream, [x, 2.72, 0], [.13,.13,.13], g); }
  mesh(cylinder, materials.ink, [0, 2.36, 0], [.018, 3.05, .018], g, false).rotation.z = Math.PI / 2;
  [-.85,0,.85].forEach((x, i) => {
    const garment = new THREE.Group(); garment.position.set(x, 1.72, 0); g.add(garment);
    const garmentMat = [materials.peach,materials.mint,materials.lavender][i];
    mesh(new THREE.BoxGeometry(1,1,1), garmentMat, [0, 0, 0], [.52, .68, .08], garment, false);
    if (i === 1) mesh(new THREE.CylinderGeometry(.42,.2,.5,10), garmentMat, [0,-.48,0], [1,1,.22], garment, false);
    swayingProps.push({ object:garment, phase:i * .9, amount:.06 });
  });
  const basket=mesh(new THREE.CylinderGeometry(.52,.42,.45,14), materials.cream, [1.95,.26,.55], [1,1,1], g);
  basket.material=mat(0xD8B08A); for(let item=0;item<3;item++)mesh(sphere,[materials.peach,materials.sky,materials.lavender][item],[1.7+item*.18,.48,.55],[.18,.1,.18],g,false);
  createBench(-7.7, -11.35);
  createBunting(g, [-1.4,2.7,.08], 6, [materials.peach,materials.sky,materials.lavender]);
  signAt('CLOTHESLINE LANE', -10, -10, 3.2);
}

function createRibbonGarden() {
  const g = groupAt(-11, 0, 11.5);
  natureProp('fence_gate',g,[0,0,2.75],1.2,Math.PI); natureProp('tree_default',g,[-2.8,0,2.05],1.05,.2); natureProp('tree_oak',g,[2.8,0,2.15],.92,-.3);
  treeBlockers.push({x:-13.8,z:13.55,radius:.5},{x:-8.2,z:13.65,radius:.55});
  for (const x of [-1.2,1.2]) mesh(cylinder, materials.cream, [x,1.2,0],[.11,2.4,.11],g);
  const arch = mesh(new THREE.TorusGeometry(1.2,.11,8,24,Math.PI), materials.cream, [0,2.38,0],[1,1,1],g); arch.rotation.z = 0;
  [-.7,0,.7].forEach((x,i)=>{const geometry=new THREE.BoxGeometry(1,1,1); geometry.translate(0,-.5,0); const ribbon=mesh(geometry,[materials.peach,materials.lavender,materials.sky][i],[x,1.72,0],[.1,.95,.04],g,false); swayingProps.push({object:ribbon,phase:i,amount:.09});});
  mesh(dodeca, materials.leaf, [-1.8,.55,.4],[.65,.55,.65],g); mesh(dodeca, materials.leaf, [1.8,.55,.4],[.65,.55,.65],g);
  createFlowerCluster(-12.5, 11); createFlowerCluster(-9.5, 12.2);
  createBench(-11.2, 14.6);
  signAt('RIBBON GARDEN', -11, 11.5, 3.1);
}

function createStickerKiosk() {
  const g = groupAt(11,0,-11);
  solidFootprints.push({x:11,z:-11,width:3,depth:2.2,rotation:0});
  const core=new THREE.Group(); g.add(core); stickerKiosk = core;
  mesh(box, materials.peach, [0,.72,0],[2.5,1.35,1.25],core);
  mesh(box, materials.cream, [0,1.48,-.15],[2.8,.16,1.7],core);
  mesh(box, materials.lavender, [0,1.73,0],[2.35,.35,1.45],core);
  createStripedAwning(core,-.82,materials.peach,1.72);
  const icons=[new THREE.ShapeGeometry(starShape(.28,.13)),heartGeometry()];
  icons.forEach((geometry,i)=>{mesh(geometry,[materials.yellow,materials.coral][i],[-.72+i*.72,1.05,-.7],[i===1?.8:1,i===1?.8:1,1],core,false);});
  for(let petalIndex=0;petalIndex<5;petalIndex++){
    const angle=petalIndex*Math.PI*2/5;
    mesh(sphere,materials.mint,[.72+Math.cos(angle)*.19,1.05+Math.sin(angle)*.19,-.72],[.13,.19,.05],core,false).rotation.z=angle;
  }
  mesh(sphere,materials.yellow,[.72,1.05,-.76],[.11,.11,.05],core,false);
  natureProp('sign',g,[-2.35,0,-.15],.8,.25); natureProp('sign',g,[2.35,0,-.15],.8,-.25);
  mesh(box,materials.cream,[-1.75,.25,.75],[.55,.5,.55],g); mesh(box,materials.cream,[1.7,.18,.8],[.42,.36,.42],g);
  signAt('STICKER CARNIVAL', 11, -11, 2.8);
}

function createGiantHandbag() {
  const g=groupAt(8,0,8,.08);
  solidFootprints.push({x:8,z:8,width:2.4,depth:.85,rotation:.08});
  mesh(box,materials.peach,[0,1.05,0],[2.4,1.75,.85],g);
  const handle=mesh(new THREE.TorusGeometry(.72,.14,10,24,Math.PI),materials.lavender,[0,1.92,0],[1,1,.6],g); handle.rotation.z=0;
  const badge=mesh(heartGeometry(),materials.cream,[0,1.05,-.46],[.42,.42,.42],g,false); badge.rotation.z=Math.PI;
}

function createDuckPond() {
  const pond=mesh(new THREE.CircleGeometry(2,48),mat(C.sky,{transparent:true,opacity:.72}),[-14,.015,5],[1.25,1,1],scene,false); pond.rotation.x=-Math.PI/2;
  for(let i=0;i<3;i++){
    const duck=new THREE.Group(); scene.add(duck);
    mesh(sphere,materials.yellow,[0,.18,0],[.38,.24,.27],duck,false);
    mesh(sphere,materials.yellow,[.25,.42,0],[.22,.22,.22],duck,false);
    const beak=mesh(new THREE.ConeGeometry(.11,.25,4),mat(0xF39A45),[.49,.39,0],[1,1,.7],duck,false); beak.rotation.z=-Math.PI/2;
    for(const z of [-.1,.1]) mesh(sphere,materials.ink,[.37,.49,z],[.027,.027,.027],duck,false);
    townDucks.push({duck,phase:i*Math.PI*2/3,radius:.72+i*.28,speed:.16+i*.035});
  }
  for(const offset of [-1,1]) { const reeds=groupAt(-14+offset*1.25,0,5.35); for(let i=0;i<3;i++){const reed=mesh(cylinder,materials.leaf,[i*.12,.38+i*.07,0],[.025,.75+i*.14,.025],reeds,false); reed.rotation.z=(i-1)*.12;} }
  natureProp('rock_smallA',scene,[-17.35,.02,5.9],1.2,.3); natureProp('rock_smallA',scene,[-10.75,.02,5.2],.95,-.5);
  natureProp('tree_oak',scene,[-19,0,3.8],1.05,.4); treeBlockers.push({x:-19,z:3.8,radius:.6});
  signAt('DUCK BOARDWALK',-14,5,2.8);
}

function createLamppost(x,z,colour){
  const g=groupAt(x,0,z); mesh(cylinder,materials.cream,[0,.95,0],[.075,1.9,.075],g); mesh(sphere,mat(colour,{emissive:colour,emissiveIntensity:.18}),[0,1.95,0],[.24,.3,.24],g); mesh(new THREE.ConeGeometry(.38,.28,8),materials.ink,[0,2.23,0],[1,1,1],g);
}

function createPicnic() {
  const g=groupAt(17,0,14); const blanket=mesh(box,materials.lavender,[0,.04,0],[2.2,.06,1.55],g,false); blanket.rotation.y=.16;
  mesh(new THREE.CylinderGeometry(.32,.38,.48,10),materials.brown,[.5,.28,0],[1,1,1],g); mesh(box,materials.peach,[-.55,.18,.25],[.62,.28,.55],g); mesh(box,materials.mint,[-.35,.18,-.4],[.62,.28,.55],g);
}

function createButterfly(phase) {
  const g=new THREE.Group(); scene.add(g); const wingMat=phase ? materials.peach : materials.lavender;
  const left=mesh(new THREE.PlaneGeometry(.22,.14),wingMat,[-.12,0,0],[1,1,1],g,false); const right=mesh(new THREE.PlaneGeometry(.22,.14),wingMat,[.12,0,0],[1,1,1],g,false);
  butterflies.push({g,left,right,phase});
}

function createTownLife() {
  createFashionFountain(); createClotheslineLane(); createRibbonGarden(); createStickerKiosk(); createGiantHandbag(); createDuckPond();
  [[-7,-5],[7,-5],[-7,5],[7,5],[-1,-10],[17,1]].forEach(([x,z],i)=>createLamppost(x,z,[C.peach,C.lavender,C.sky,C.mint,C.yellow,C.coral][i]));
  [[-7,13],[8,-13],[14,5],[-15,-8]].forEach(([x,z])=>createFlowerCluster(x,z));
  createButterfly(0); createButterfly(1); createPicnic();
  const marks=[{x:-4,z:1,shape:starShape(.38,.18),mat:materials.lavender},{x:4,z:-1,shape:heartGeometry(),mat:materials.peach}];
  marks.forEach(mark=>{const m=mesh(mark.shape instanceof THREE.Shape ? new THREE.ShapeGeometry(mark.shape) : mark.shape,mark.mat,[mark.x,.025,mark.z],[1,1,1],scene,false); m.rotation.x=-Math.PI/2;});
}

function updateTownLife() {
  const ambienceElapsed=elapsed*.5;
  fountainJets.forEach((jet,index)=>{const t=(ambienceElapsed*.58+jet.phase)%1; const reach=Math.sin(t*Math.PI)*.72; jet.orb.position.set(Math.cos(jet.angle)*reach,.58+Math.sin(t*Math.PI)*1.25,Math.sin(jet.angle)*reach); jet.orb.visible=t>.03;});
  fountainSparkles.forEach((item,index)=>{const angle=ambienceElapsed*.6+item.phase;item.mesh.position.set(Math.cos(angle)*item.radius,.53+Math.sin(ambienceElapsed*2.4+index)*.035,Math.sin(angle)*item.radius);item.mesh.rotation.y=ambienceElapsed*2+index;});
  swayingProps.forEach(item=>{item.object.rotation.z=Math.sin(ambienceElapsed*1.45+item.phase)*item.amount;});
  townDucks.forEach(item=>{const a=ambienceElapsed*item.speed+item.phase; item.duck.position.set(-14+Math.cos(a)*item.radius,.13,5+Math.sin(a)*item.radius*.72); item.duck.rotation.y=-a;});
  butterflies.forEach((item,index)=>{const a=ambienceElapsed*.38+item.phase*Math.PI; item.g.position.set(-11+Math.cos(a)*1.8,1.2+Math.sin(ambienceElapsed*1.7+index)*.25,9+Math.sin(a*1.35)*1.25); const flap=Math.sin(ambienceElapsed*8+index)*.75; item.left.rotation.y=flap; item.right.rotation.y=-flap;});
}

function createFloorRing(position, colour) {
  const geometry = new THREE.RingGeometry(.85, 1.15, 48);
  const material = new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: .3, side: THREE.DoubleSide, depthWrite: false });
  const ring = new THREE.Mesh(geometry, material);
  ring.position.copy(position).add(new THREE.Vector3(0, .035, 0));
  ring.rotation.x = -Math.PI / 2;
  scene.add(ring);
  return ring;
}

function createFeatureBuilding({ x, z, rotation, main, accent, label, kind }) {
  const g = groupAt(x, 0, z, rotation);
  solidFootprints.push({x,z,width:7.2,depth:5.3,rotation});
  mesh(box, main, [0, 2.3, 0], [7.2, 4.6, 5.3], g);
  mesh(box, materials.cream, [0, 3.9, -2.69], [6.6, 1.05, .16], g);
  const roof = mesh(new THREE.ConeGeometry(5.15, 2.1, 4), materials.ink, [0, 5.15, 0], [1, 1, .78], g);
  roof.rotation.y = Math.PI / 4;
  mesh(box, accent, [0, .35, -2.76], [7.5, .5, .28], g);
  mesh(box, materials.glass, [-1.62, 2.25, -2.72], [2.65, 2.25, .16], g);
  mesh(box, materials.ink, [-1.62, 2.25, -2.8], [.09, 2.25, .07], g, false);
  mesh(box, materials.ink, [-1.62, 2.25, -2.8], [2.65, .09, .07], g, false);
  mesh(box, materials.cream, [1.45, 1.55, -2.78], [1.15, 3.1, .2], g);
  mesh(sphere, materials.gold, [1.08, 1.55, -2.92], [.07, .07, .07], g, false);
  createStripedAwning(g, -3.06, kind === 'studio' ? materials.lavender : materials.mint);
  createPlanter(g, -2.85, -2.95, kind === 'studio' ? materials.peach : materials.yellow);
  createPlanter(g, 2.82, -2.95, kind === 'studio' ? materials.lavender : materials.peach);
  if (kind === 'shop') {
    mesh(box,mat(0xFFE7A8,{emissive:0xFFD47A,emissiveIntensity:.38}),[-1.62,2.25,-2.58],[2.35,2.05,.08],g,false);
    mesh(box,materials.brown,[-1.62,.72,-2.3],[2.65,.82,.7],g);
    createBunting(g,[-3,3.5,-2.92],10,[materials.mint,materials.peach,materials.lavender]);
    natureProp('sign',g,[-4.05,0,-2.6],.85,.1); natureProp('sign',g,[3.9,0,-2.35],.85,-.15);
    for(const rackX of [-3.15,2.85]){
      mesh(cylinder,materials.ink,[rackX,1.15,-3.25],[.05,1.7,.05],g); mesh(cylinder,materials.ink,[rackX+.58,1.15,-3.25],[.05,1.7,.05],g);
      const rail=mesh(cylinder,materials.ink,[rackX+.29,1.8,-3.25],[.04,.58,.04],g); rail.rotation.z=Math.PI/2;
      mesh(box,rackX<0?materials.peach:materials.lavender,[rackX+.29,1.25,-3.25],[.42,.7,.08],g,false);
    }
    createShopShowcase(g);
  } else {
    mesh(box,mat(0xFFE7A8,{emissive:0xFFD47A,emissiveIntensity:.35}),[-1.62,2.25,-2.58],[2.35,2.05,.08],g,false);
    for(let index=0;index<4;index++){
      const roll=mesh(cylinder,[materials.peach,materials.lavender,materials.mint,materials.sky][index],[ -2.35+index*.5,1.45,-2.48],[.15,.75,.15],g); roll.rotation.z=Math.PI/2;
    }
    mesh(box,materials.ink,[-.85,1.05,-2.5],[.62,.12,.18],g,false); mesh(cylinder,materials.ink,[-.65,1.35,-2.5],[.12,.5,.12],g,false);
    const spool=mesh(new THREE.TorusGeometry(.36,.12,10,22),materials.peach,[3.75,2.55,-2.55],[1,1,.4],g,false); spool.rotation.y=.1;
    createBunting(g,[-3,3.55,-2.92],10,[materials.peach,materials.lavender,materials.sky]);
  }
  const sign = worldLabel(label);
  sign.position.set(0, 4.15, -2.9);
  g.add(sign);
  mesh(box, materials.cream, [3.75, 1.15, -2.5], [.14, 2.3, .14], g);
  return g;
}

function createBackgroundBuilding(x, z, index) {
  const wallMats = [materials.peach, materials.sky, materials.yellow, materials.lavender, materials.mint, materials.cream].map(source=>{const muted=source.clone();muted.color.lerp(new THREE.Color(C.cream),.45);return muted;});
  const widths = [4.6, 5.1, 4.4, 5.3, 4.7, 5.0];
  const g = groupAt(x, 0, z, Math.atan2(x, z));
  const w = widths[index];
  const h = 3.7 + (index % 3) * .32;
  mesh(box, wallMats[index], [0, h / 2, 0], [w, h, 3.8], g);
  const roof = mesh(new THREE.ConeGeometry(w * .72, 1.65 + (index % 2) * .3, 4), materials.ink, [0, h + .72, 0], [1, 1, .82], g);
  roof.rotation.y = Math.PI / 4;
  mesh(box, materials.cream, [0, .9, -1.95], [.9, 1.8, .12], g);
  for (const wx of [-w * .28, w * .28]) {
    mesh(box, materials.glass, [wx, 2.35, -1.96], [.78, .78, .1], g);
    mesh(box, materials.cream, [wx, 2.35, -2.03], [.07, .78, .05], g, false);
    mesh(box, materials.cream, [wx, 2.35, -2.03], [.78, .07, .05], g, false);
  }
  mesh(box, materials.cream, [0, .15, -2.05], [w + .25, .3, .25], g);
  return g;
}

// 8. world construction
const treeBlockers = [];
const solidFootprints = [];
const readableLabels = [];
const deliveryPads = [];
const boostLanes = [];
const jumpGates = [];
const comicEvents = [];
const discoLights = [];
const navNodes = [];
const navByKey = new Map();
const pickupSlots = new Map();
const walkingDistanceCache = new Map();
let selectedPickup=null;
let selectedCounter=null;
let navigationRoute=null;
let lastMapUpdate = -Infinity;

function horizontalDistance(a,b) {
  const ax = Array.isArray(a) ? a[0] : a.x, az = Array.isArray(a) ? a[1] : a.z;
  const bx = Array.isArray(b) ? b[0] : b.x, bz = Array.isArray(b) ? b[1] : b.z;
  return Math.hypot(ax-bx,az-bz);
}
function clearWalkSegment(a,b) {
  const distance = horizontalDistance(a,b), steps = Math.max(1,Math.ceil(distance/.25));
  for(let i=0;i<=steps;i++) {
    const x=a[0]+(b[0]-a[0])*i/steps, z=a[1]+(b[1]-a[1])*i/steps;
    if(Math.abs(x)>PLAYER_BOUNDS || Math.abs(z)>PLAYER_BOUNDS || collides(x,z)) return false;
  }
  return true;
}
function buildNavigation() {
  navNodes.length=0; navByKey.clear();
  for(let x=-PLAYER_BOUNDS;x<=PLAYER_BOUNDS;x++) for(let z=-PLAYER_BOUNDS;z<=PLAYER_BOUNDS;z++) {
    if(collides(x,z)) continue;
    const node={point:[x,z],neighbors:[]}; navNodes.push(node); navByKey.set(`${x},${z}`,node);
  }
  navNodes.forEach(node => {
    for(let dx=-1;dx<=1;dx++) for(let dz=-1;dz<=1;dz++) {
      if(!dx&&!dz) continue;
      const neighbor=navByKey.get(`${node.point[0]+dx},${node.point[1]+dz}`);
      if(neighbor&&clearWalkSegment(node.point,neighbor.point)) node.neighbors.push(neighbor);
    }
  });
}
function walkingPath(from,to) {
  const start=Array.isArray(from)?from:[from.x,from.z], end=Array.isArray(to)?to:[to.x,to.z];
  if(clearWalkSegment(start,end)) return [start,end];
  // Check nearer nodes first; scanning every distant node repeated thousands of
  // collision samples for each supplier route while picking an order.
  const nearest=point=>[...navNodes].sort((a,b)=>horizontalDistance(point,a.point)-horizontalDistance(point,b.point)).find(node=>clearWalkSegment(point,node.point));
  const first=nearest(start), last=nearest(end);
  if(!first||!last) throw new Error(`No walking route from ${start} to ${end}`);
  const open=new Set([first]), costs=new Map([[first,0]]), previous=new Map();
  while(open.size) {
    let current=null, best=Infinity;
    for(const node of open) { const score=costs.get(node)+horizontalDistance(node.point,last.point); if(score<best){best=score;current=node;} }
    if(current===last) {
      const route=[end]; let node=last;
      while(node){route.unshift(node.point);node=previous.get(node);}
      route.unshift(start);
      // Straighten only segments that pass the same clearance check as player movement.
      const result=[route[0]]; let index=0;
      while(index<route.length-1){let next=route.length-1;while(next>index+1&&!clearWalkSegment(route[index],route[next]))next--;result.push(route[next]);index=next;}
      return result;
    }
    open.delete(current);
    for(const neighbor of current.neighbors) {
      const cost=costs.get(current)+horizontalDistance(current.point,neighbor.point);
      if(cost>=(costs.get(neighbor)??Infinity)) continue;
      costs.set(neighbor,cost);previous.set(neighbor,current);open.add(neighbor);
    }
  }
  throw new Error(`Disconnected town route to ${end}`);
}
function walkingLength(from,to) {
  const a=Array.isArray(from)?from:[from.x,from.z],b=Array.isArray(to)?to:[to.x,to.z],key=`${a}:${b}`;
  if(walkingDistanceCache.has(key))return walkingDistanceCache.get(key);
  const path=walkingPath(from,to);
  const length=path.slice(1).reduce((length,point,index)=>length+horizontalDistance(path[index],point),0);
  if(walkingDistanceCache.size>2000)walkingDistanceCache.clear();
  walkingDistanceCache.set(key,length);return length;
}
function nearestCraftingCounter(position=player.position) {
  return CRAFTING_COUNTERS.reduce((best,counter)=>walkingLength(position,counter.point)<walkingLength(position,best.point)?counter:best);
}
function preparePickupSlots() {
  const reserved=[...DISTRICTS.map(item=>item.destination),...CRAFTING_COUNTERS.map(item=>[item.point.x,item.point.z]),[SHOP_POINT.x,SHOP_POINT.z],...JUMP_SHORTCUTS.flatMap(item=>[item.from,item.to,item.point])];
  const candidates=navNodes.map(node=>node.point).filter(point=>horizontalDistance(point,[0,0])>4.5&&reserved.every(other=>horizontalDistance(point,other)>2.5)&&[[1.4,0],[-1.4,0],[0,1.4],[0,-1.4]].every(([dx,dz])=>clearWalkSegment(point,[point[0]+dx,point[1]+dz])));
  const used=[];
  // Reserve the busiest districts first. Slots are validated once, then their
  // component assignments are shuffled with the run seed, never during play.
  const districts=[...DISTRICTS].sort((a,b)=>COMPONENT_DEFINITIONS.filter(item=>item.districtId===b.id).length-COMPONENT_DEFINITIONS.filter(item=>item.districtId===a.id).length);
  for(const district of districts){
    const count=COMPONENT_DEFINITIONS.filter(item=>item.districtId===district.id).length;
    const slots=[];
    for(let index=0;index<count;index++){
      const point=candidates.filter(point=>used.every(other=>horizontalDistance(point,other)>=3.3)).sort((a,b)=>horizontalDistance(a,district.center)-horizontalDistance(b,district.center))[0];
      if(!point||horizontalDistance(point,district.center)>11)throw Error(`No safe supply slot in ${district.name}`);
      walkingPath([-4,-4],point);slots.push([...point]);used.push(point);
    }
    if(district.id==='ducks'){const index=slots.findIndex(([x,z])=>x===-14&&z===5);if(index>=0)slots[index]=[-8,2];}
    pickupSlots.set(district.id,slots);
  }
}
function assignPickupSlots() {
  selectedPickup=null;selectedCounter=null;navigationRoute=null;
  for(const district of DISTRICTS){
    const slots=shuffleWithRunRandom(pickupSlots.get(district.id).map(point=>[...point]));
    COMPONENT_DEFINITIONS.filter(item=>item.districtId===district.id).forEach((definition,index)=>{
      definition.home=slots[index];
      const pickup=pickups.find(item=>item.definition===definition);
      if(pickup){pickup.home=definition.home;pickup.anchor.set(definition.home[0],0,definition.home[1]);pickup.group.position.copy(pickup.anchor);}
    });
  }
  initTownMap();
}
function estimateOrderRouteLength(unused,destinationId) {
  let start=[player.position.x,player.position.z];
  if(collides(...start))start=navNodes.reduce((best,node)=>horizontalDistance(start,node.point)<horizontalDistance(start,best.point)?node:best).point;
  const missing=MATERIAL_CATEGORIES.filter(category=>categoryTotal(category)===0),full=(1<<missing.length)-1;
  const stops=COMPONENT_DEFINITIONS.filter(item=>missing.includes(item.category));
  const costs=Array.from({length:full+1},()=>new Map());costs[0].set(-1,0);
  for(let mask=0;mask<=full;mask++)for(const [last,cost] of costs[mask]){
    const point=last<0?start:stops[last].home;
    stops.forEach((stop,index)=>{const bit=1<<missing.indexOf(stop.category);if(mask&bit)return;
      const next=mask|bit,value=cost+walkingLength(point,stop.home);if(value<(costs[next].get(index)??Infinity))costs[next].set(index,value);
    });
  }
  const destination=DISTRICTS.find(item=>item.id===destinationId).destination;let best=Infinity;
  for(const [last,cost] of costs[full])for(const counter of CRAFTING_COUNTERS){const point=last<0?start:stops[last].home;best=Math.min(best,cost+walkingLength(point,counter.point)+walkingLength(counter.point,destination));}
  return best;
}
function deadlineForDifficulty(seconds,difficulty){const [factor,extra,min,max]=difficulty==='HARD'?[1.2,6,25,50]:difficulty==='MEDIUM'?[1.4,9,30,60]:[1.65,12,35,70];return THREE.MathUtils.clamp(Math.ceil(seconds*factor+extra),min,max);}
function estimateOrderDeadline(unused,destinationId,difficulty='EASY') { return deadlineForDifficulty(Math.ceil(estimateOrderRouteLength(null,destinationId)/TOP_SPEED),difficulty); }

function supplierHint(category,type) {
  return [...new Set(COMPONENT_DEFINITIONS.filter(item=>item.category===category&&item.type===type).map(item=>item.landmark))].join(' or ');
}
function beginPractice() {
  if(!gameReady)return;
  beginRun(true);gameState.practice=true;gameState.timerStarted=false;
  if(gameState.modalOpen==='orders')closeModal('orders');
  const offer=gameState.orderOffers.reduce((best,item)=>{
    const customer=customers.find(c=>c.id===item.customerId),previous=customers.find(c=>c.id===best?.customerId);
    return !previous||horizontalDistance(player.position,customer.wrapper.position)<horizontalDistance(player.position,previous.wrapper.position)?item:best;
  },null);
  const destination=DISTRICTS.reduce((best,item)=>estimateOrderRouteLength(null,item.id)<estimateOrderRouteLength(null,best.id)?item:best);
  gameState.practiceOffer={...offer,destinationId:destination.id};gameState.orderOffers=[gameState.practiceOffer];
  customers.forEach(refreshCustomerBubble);updateHUD();updateControlVisibility();
}
function finishPractice() {
  if(!gameState.practice)return;
  onboardingSeen=true;saveSettings();beginRun(false);
  toast(`READY! Beat your best in ${STARTING_TIME} seconds.`);
}
function updatePracticeGuide() {
  const guide=document.querySelector('#practice-guide');
  guide.classList.toggle('hidden',!gameState.practice||!gameState.started);
  if(!gameState.practice)return;
  let instruction='';
  const action=touchDevice?'tap INTERACT':'press E';
  if(gameState.practiceFinishing)instruction=`DELIVERED! Your fresh ${STARTING_TIME}-second run starts next.`;
  else if(!gameState.activeOrder){const customer=customers.find(c=>c.id===gameState.practiceOffer?.customerId);instruction=`1 · Follow the arrow to ${customer?.name||'your customer'} and ${action} to accept.`;}
  else if(gameState.hasFinishedDesign&&!gameState.designRejected)instruction=`4 · Follow the arrow to the customer’s delivery pad and ${action} to sell.`;
  else {
    const missing=missingTargetComponent();
    instruction=missing?`2 · Follow the arrow to the glowing ${pickupLabelText(missing)}, then ${action} to pick it up (${readyCategoryCount()}/4).`:`3 · Follow the arrow to a counter and ${action}. Choose your materials, cut and accent, MAKE IT, hit the green centre, then TAKE LOOK.`;
  }
  document.querySelector('#practice-instruction').textContent=instruction;
}
// Relocate the existing panels rather than maintaining a second brief or map.
function syncCompactLayout() {
  const nextCompactMode=Math.min(gameViewport.width,gameViewport.height)<=600;
  if(nextCompactMode===compactMode&&compactPanelHomes.size)return;
  compactMode=nextCompactMode;
  document.body.classList.toggle('compact-viewport',compactMode);
  const panels=[['.stats-panel','#details-stats'],['#score-card','#details-stats'],['#target-card','#details-brief'],['#town-map','#details-map'],['#practice-guide','#details-practice'],['#sound-button','#details-actions'],['#orders-button','#details-actions'],['#guide-button','#details-actions'],['#pause-button','#phone-pause'],['.timer-stack','#phone-timers'],['#direction-card','#phone-navigation'],['#studio-reveal','#compact-reveal'],['#design-supply-status','#compact-supply-status']];
  for(const [selector,host] of panels){
    const element=document.querySelector(selector);
    if(!compactPanelHomes.has(element)){
      const anchor=document.createComment(`Home for ${selector}`);element.before(anchor);compactPanelHomes.set(element,anchor);
    }
    if(compactMode)document.querySelector(host).append(element);
    else compactPanelHomes.get(element).after(element);
  }
  if(!compactMode&&gameState.modalOpen==='details')closeModal('details');
  // Navigation precedes the contextual/practice instruction in the compact strip.
  document.querySelector('#phone-navigation').append(document.querySelector('#phone-hint'));
  updateTimerDisplay();updateOrderTimerDisplay();updateCompactHUD();
}
function syncGameViewport() {
  const next=readGameViewport();
  const root=document.documentElement.style;
  if(root.getPropertyValue('--game-width')&&Object.entries(next).every(([key,value])=>gameViewport[key]===value))return;
  Object.assign(gameViewport,next);
  for(const [key,value] of Object.entries(gameViewport))root.setProperty(`--game-${key}`,`${value}px`);
  camera.aspect=gameViewport.width/gameViewport.height;camera.updateProjectionMatrix();
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,touchDevice?1:1.5));
  renderer.setSize(gameViewport.width,gameViewport.height);
  labelRenderer.setSize(gameViewport.width,gameViewport.height);
  syncCompactLayout();clearInput();lastMapUpdate=-Infinity;
}
function updateCompactHUD() {
  if(!compactMode)return;
  document.querySelector('#phone-coins').textContent=document.querySelector('#coins-value').textContent;
  document.querySelector('#phone-capacity').textContent=document.querySelector('#capacity-value').textContent;
  document.querySelector('#phone-score').textContent=document.querySelector('#score-value').textContent;
  for(const [selector,label]of [['#phone-coins','Coins'],['#phone-capacity','Bag capacity'],['#phone-score','Score']]){
    const counter=document.querySelector(selector);counter.parentElement.setAttribute('aria-label',`${label}: ${counter.textContent}`);
  }
  document.querySelector('#details-no-order').hidden=Boolean(gameState.activeOrder);
  let hint='DETAILS · brief, map & help';
  const action=touchDevice?'INTERACT':'E';
  if(gameState.practice){
    hint=!gameState.activeOrder?`1 · Meet your customer · ${action}`:gameState.practiceFinishing?'Delivered! Your scored run starts next.':gameState.hasFinishedDesign&&!gameState.designRejected?`4 · Return to your customer · ${action}`:missingTargetComponent()?`2 · Collect garment, dye, motif & trim · ${readyCategoryCount()}/4`:'3 · Visit a counter · design, stitch & take your look';
  }
  const prompt=document.querySelector('#interaction-prompt');
  if(prompt.classList.contains('visible'))hint=`${action} · ${prompt.querySelector('span').textContent}`;
  document.querySelector('#phone-hint').textContent=hint;
}
function updateControlVisibility() {
  const playing=gameState.started&&!gameState.gameOver&&!gameState.modalOpen&&!manualPaused;
  document.querySelector('#touch-controls').classList.toggle('hidden',!touchDevice||!playing);
  document.querySelector('#practice-guide').classList.toggle('hidden',!gameState.practice||!gameState.started);
  document.body.classList.toggle('touch-device',touchDevice);
  document.body.classList.toggle('practicing',gameState.practice&&gameState.started);
  document.body.classList.toggle('inspecting',Boolean(gameState.modalOpen)||manualPaused);
}
function updateDirection() {
  const card=document.querySelector('#direction-card');
  card.classList.toggle('hidden',!gameState.started||gameState.gameOver||Boolean(gameState.modalOpen));
  const target=navigationTarget();
  if(!target){card.classList.add('hidden');return;}
  const point=target.point, now=gameNow();
  if(!navigationRoute||navigationRoute.id!==target.id||horizontalDistance(navigationRoute.end,point)>.75||horizontalDistance(navigationRoute.start,player.position)>2||now-navigationRoute.at>750){
    let start=[player.position.x,player.position.z];
    if(collides(...start))start=navNodes.reduce((best,node)=>horizontalDistance(start,node.point)<horizontalDistance(start,best.point)?node:best).point;
    navigationRoute={id:target.id,start:[...start],end:point.clone(),at:now,path:walkingPath(start,point)};
  }
  while(navigationRoute.path.length>2&&horizontalDistance(player.position,navigationRoute.path[1])<.8)navigationRoute.path.shift();
  const waypoint=navigationRoute.path[1],offset=new THREE.Vector3(waypoint[0],0,waypoint[1]).sub(player.position).setY(0),forward=cameraTarget.clone().sub(camera.position).setY(0).normalize(),right=new THREE.Vector3().crossVectors(forward,worldUp).normalize();
  document.querySelector('#direction-arrow').style.transform=`rotate(${Math.atan2(offset.dot(right),offset.dot(forward))*180/Math.PI}deg)`;
  const distance=horizontalDistance(player.position,waypoint)+navigationRoute.path.slice(2).reduce((length,end,index)=>length+horizontalDistance(navigationRoute.path[index+1],end),0);
  document.querySelector('#direction-text').textContent=`${target.label} · ${Math.ceil(distance)}m`;
}
function bindReleaseControls() {
  document.querySelector('#practice-button').addEventListener('click',beginPractice);
  document.querySelector('#skip-practice').addEventListener('click',finishPractice);
  document.querySelector('#pause-button').addEventListener('click',()=>setManualPause(true));
  document.querySelector('#resume-button').addEventListener('click',()=>setManualPause(false));
  document.querySelector('#pause-title-button').addEventListener('click',returnToTitle);
  document.querySelector('#phone-details-button').addEventListener('click',()=>openModal('details'));
  document.querySelector('#close-details').addEventListener('click',()=>closeModal('details'));
  for(const footer of document.querySelectorAll('.modal-card footer,.pause-panel')){
    const skip=document.createElement('button');skip.className='secondary practice-modal-skip';skip.textContent='SKIP PRACTICE';skip.addEventListener('click',finishPractice);footer.prepend(skip);
  }
  updateInputHints();
  const stick=document.querySelector('#joystick');
  const move=event=>{
    if(event.pointerId!==touchInput.pointerId)return;
    const rect=stick.getBoundingClientRect(),radius=rect.width*.32;
    let x=(event.clientX-rect.left-rect.width/2)/radius,y=(event.clientY-rect.top-rect.height/2)/radius;
    const length=Math.hypot(x,y);if(length>1){x/=length;y/=length;}
    touchInput.x=Math.abs(x)<.12?0:x;touchInput.y=Math.abs(y)<.12?0:y;
    document.querySelector('#joystick-thumb').style.transform=`translate(${x*radius}px,${y*radius}px)`;
    event.preventDefault();
  };
  stick.addEventListener('pointerdown',event=>{if(simulationSuspended()||gameState.modalOpen||touchInput.pointerId!==null)return;touchInput.pointerId=event.pointerId;stick.setPointerCapture(event.pointerId);move(event);});
  stick.addEventListener('pointermove',move);
  const release=event=>{if(event.pointerId===touchInput.pointerId)clearInput();};
  for(const name of ['pointerup','pointercancel','lostpointercapture'])stick.addEventListener(name,release);
  for(const [id,action] of [['touch-interact',handleInteraction],['touch-jump',startJump],['touch-drop',quickDrop],['touch-bag',toggleBag],['touch-guide',activateGuide]]) {
    document.querySelector(`#${id}`).addEventListener('pointerdown',event=>{event.preventDefault();if(!simulationSuspended())action();});
  }
  window.addEventListener('blur',()=>{clearInput();setSuspended('focus',true);});
  window.addEventListener('focus',()=>setSuspended('focus',false));
  document.addEventListener('visibilitychange',()=>setSuspended('hidden',document.visibilityState==='hidden'));
  document.addEventListener('keydown',event=>{
    const container=manualPaused?document.querySelector('#pause-screen'):gameState.modalOpen?document.querySelector(`#${gameState.modalOpen}-modal`):null;
    if(event.key!=='Tab'||!container)return;
    const controls=[...container.querySelectorAll('button:not(:disabled),a[href]')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');
    if(!controls.length)return;
    const first=controls[0],last=controls.at(-1);
    if(event.shiftKey&&(document.activeElement===first||!container.contains(document.activeElement))){last.focus();event.preventDefault();}
    else if(!event.shiftKey&&(document.activeElement===last||!container.contains(document.activeElement))){first.focus();event.preventDefault();}
  });
  updateControlVisibility();
}

function buildDeliveryTown() {
  for(const [text,point] of [['DESIGN STUDIO',STUDIO_POINT],['MY SHOP',SHOP_POINT]]) {
    const label=worldLabel(text);label.position.copy(point).setY(1.8);if(text==='MY SHOP')label.element.classList.add('shop-sign');scene.add(label);
  }
  TOWN_ROUTES.forEach(route=>route.slice(1).forEach((end,index)=>{
    const start=route[index], length=horizontalDistance(start,end);
    const road=mesh(box,materials.path,[(start[0]+end[0])/2,.01,(start[1]+end[1])/2],[3.2,.035,length],scene,false);
    road.rotation.y=Math.atan2(end[0]-start[0],end[1]-start[1]);
  }));
  STUNT_LANES.forEach(lane=>{
    const rotation=Math.atan2(...lane.direction),length=horizontalDistance(lane.entry,lane.exit);
    const path=mesh(box,materials.path,[(lane.entry[0]+lane.exit[0])/2,.035,(lane.entry[1]+lane.exit[1])/2],[2.4,.03,length],scene,false);path.rotation.y=rotation;
    for(let distance=.4;distance<length;distance+=1){const chevron=mesh(new THREE.ConeGeometry(.22,.5,3),materials.cream,[lane.entry[0]+lane.direction[0]*distance,.07,lane.entry[1]+lane.direction[1]*distance],[1,1,.08],scene,false);chevron.rotation.set(Math.PI/2,0,-rotation);}
    const pad=mesh(box,materials.mint,[lane.pad[0],.09,lane.pad[1]],[1.6,.06,1.6],scene,false);pad.rotation.y=rotation;
    const hurdle=groupAt(lane.hurdle[0],0,lane.hurdle[1],rotation);mesh(box,materials.coral,[0,.22,0],[2.4,.3,.18],hurdle);
    for(const x of [-1.15,1.15])mesh(box,materials.cream,[x,.18,0],[.12,.36,.2],hurdle);
    solidFootprints.push({x:lane.hurdle[0],z:lane.hurdle[1],width:2.4,depth:.2,rotation,jumpable:true,laneId:lane.id});
    const hoop=mesh(new THREE.TorusGeometry(.8,.08,8,24),materials.gold,[lane.hoop[0],.9,lane.hoop[1]],[1,1,1],scene,false);hoop.rotation.y=rotation;
    boostLanes.push({...lane,point:lane.pad,visual:pad,occupied:false,stage:0,startedAt:0,locked:false,hurdleJump:-1,hoopJump:-1});
    jumpGates.push({laneId:lane.id,point:lane.hoop,visual:hoop});
  });
  for(const district of DISTRICTS){
    const position=new THREE.Vector3(...[district.destination[0],0,district.destination[1]]),ring=createFloorRing(position,C.gold);ring.scale.setScalar(1.1);
    const label=worldLabel(`${district.short} DELIVERY`);label.position.copy(position).setY(1.4);label.userData.destinationId=district.id;scene.add(label);deliveryPads.push({district,ring,label});
  }
  for(const counter of CRAFTING_COUNTERS.slice(1)) {
    const {x,z}=counter.point;
    const g=groupAt(x,0,z-1.65);
    mesh(box,materials.lavender,[0,.6,0],[2.2,1.2,.7],g);
    mesh(box,materials.cream,[0,1.26,0],[2.4,.13,1],g);
    mesh(cylinder,materials.ink,[.45,1.52,0],[.13,.48,.13],g);
    solidFootprints.push({x,z:z-1.65,width:2.4,depth:1,rotation:0});
    const label=worldLabel(counter.name.toUpperCase()); label.position.set(x,2.4,z-1.65); label.userData.counterId=counter.id;scene.add(label);
    counter.ring=createFloorRing(counter.point,C.lavender);
  }
  const disco=groupAt(16,0,-3);
  mesh(box,materials.ink,[0,.25,0],[2,.5,5],disco);
  solidFootprints.push({x:16,z:-3,width:2,depth:5,rotation:0});
  for(let index=0;index<4;index++) {
    const light=mesh(sphere,mat([C.sky,C.mint,C.coral,C.lavender][index],{emissive:[C.sky,C.mint,C.coral,C.lavender][index],emissiveIntensity:.3}),[0,1.1,-1.8+index*1.2],[.4,.4,.4],disco);
    discoLights.push(light);
  }
  signAt('DYE DISCO',16,-3,3.1);
  signAt('RUNWAY ARCADE',8,8,3);
  for(let i=0;i<6;i++) mesh(sphere,materials.gold,[4+i*1.4,.2,9],[.12,.12,.12],scene,false);
  createGraphicSign(`${STARTING_TIME} SECONDS. SIX DISTRICTS.`,0,2.3,-16.5,0,'#FFD84A',5.3);
  buildNavigation();
  const accessPoints=[...COMPONENT_DEFINITIONS.map(item=>item.home),...DISTRICTS.map(item=>item.destination),...CRAFTING_COUNTERS.map(item=>[item.point.x,item.point.z])];
  for(const point of accessPoints) {
    if(collides(point[0],point[1])) throw new Error(`Blocked town stop at ${point}`);
    walkingPath([-4,-4],point);
  }
}

function triggerTownEvents(destinationId) {
  const count=gameState.stats.sales>=3?2:1;
  for(let index=0;index<count;index++) {
    const destinationIndex=DISTRICTS.findIndex(item=>item.id===destinationId);
    const district=DISTRICTS[(destinationIndex+index*2)%DISTRICTS.length];
    const kind=['ducks','bubbles','confetti'][Math.floor(runRandom()*3)];
    const group=groupAt(district.center[0],0,district.center[1]);
    const disposableMaterials=[];
    if(kind==='ducks') {
      for(let i=0;i<4;i++) {
        const duck=new THREE.Group();group.add(duck);
        mesh(sphere,materials.yellow,[0,.4,0],[.25,.2,.2],duck,false);
        mesh(sphere,materials.yellow,[.18,.62,0],[.15,.15,.15],duck,false);
        mesh(box,materials.peach,[.33,.6,0],[.16,.05,.11],duck,false);
      }
    } else if(kind==='bubbles') {
      const material=mat(C.sky,{transparent:true,opacity:.45,roughness:.05});disposableMaterials.push(material);
      for(let i=0;i<8;i++)mesh(sphere,material,[0,0,0],[.16+(i%3)*.08,.16+(i%3)*.08,.16+(i%3)*.08],group,false);
    } else {
      mesh(cylinder,materials.coral,[0,1,0],[.2,2,.2],group,false);
      mesh(box,materials.yellow,[0,2.2,0],[1,.4,.5],group,false);
    }
    comicEvents.push({group,kind,start:gameNow(),lastBurst:0,disposableMaterials});
  }
}
function clearTownEvents() {
  comicEvents.forEach(event=>{scene.remove(event.group);disposeGeneratedGroup(event.group);});comicEvents.length=0;
}
function updateArcadeTown(now) {
  discoLights.forEach((light,index)=>{light.material.emissiveIntensity=.25+Math.sin(elapsed*4+index)*.1;});
  if(gameState.started&&!gameState.gameOver&&!gameState.modalOpen&&!saleGameplayPaused(now))updateStuntLanes(previousStuntPosition,player.position,gameState.activePlayTime*1000);
  deliveryPads.forEach(pad=>{const active=gameState.activeOrder?.destinationId===pad.district.id;pad.ring.visible=active;pad.ring.material.opacity=.4+Math.sin(elapsed*4)*.1;});
  CRAFTING_COUNTERS.slice(1).forEach(counter=>{const ready=gameState.activeOrder&&(!gameState.hasFinishedDesign||gameState.designRejected);counter.ring.material.opacity=ready?.3:.1;});
  for(let index=comicEvents.length-1;index>=0;index--){const event=comicEvents[index],age=(now-event.start)/1000;
    if(age>6||gameState.gameOver){scene.remove(event.group);disposeGeneratedGroup(event.group);comicEvents.splice(index,1);continue;}
    if(event.kind==='ducks')event.group.children.forEach((duck,i)=>duck.position.set(((age*1.7+i*.8)%6)-3,Math.abs(Math.sin(age*7+i))*.12,Math.sin(age+i)*.35));
    if(event.kind==='bubbles')event.group.children.forEach((bubble,i)=>bubble.position.set(Math.sin(age+i)*1.3,1+(age*.7+i*.45)%3,Math.cos(age+i)*.8));
    if(event.kind==='confetti'&&now-event.lastBurst>450){burst(event.group.position.clone().setY(2.5),5,C.coral,'confetti',.7);event.lastBurst=now;}
  }
}
function boostMultiplier(){const now=gameState.activePlayTime*1000;return now<gameState.runwayRushUntil?1.8:now<gameState.speedBoostUntil?1.5:1;}
function airborneCrossing(from,to,point,direction,hoop=false){
  const before=(from.x-point[0])*direction[0]+(from.z-point[1])*direction[1],after=(to.x-point[0])*direction[0]+(to.z-point[1])*direction[1];
  if(before>=0||after<0||after-before<1e-8)return false;
  const t=-before/(after-before),x=THREE.MathUtils.lerp(from.x,to.x,t)-point[0],z=THREE.MathUtils.lerp(from.z,to.z,t)-point[1],height=THREE.MathUtils.lerp(from.y,to.y,t);
  const lateral=x*direction[1]-z*direction[0];
  return height>(hoop?.25:.4)&&(hoop?Math.hypot(lateral,height+.65-.9)<=.8:Math.abs(lateral)<=1.1);
}
function updateStuntLanes(from,to,now){
  for(const lane of boostLanes){
    const dx=to.x-lane.entry[0],dz=to.z-lane.entry[1],along=dx*lane.direction[0]+dz*lane.direction[1],lateral=dx*lane.direction[1]-dz*lane.direction[0],length=horizontalDistance(lane.entry,lane.exit);
    if(along<-.5||along>length+.5||Math.abs(lateral)>1.6){lane.locked=false;lane.stage=0;}
    const inside=horizontalDistance(to,lane.pad)<1;
    if(inside&&!lane.occupied){gameState.speedBoostUntil=Math.max(gameState.speedBoostUntil,now+2000);if(!lane.locked){lane.stage=1;lane.startedAt=now;}playSound('pickup');popup('BOOST!','sale');}
    lane.occupied=inside;
    if(lane.stage&&now-lane.startedAt>4000){lane.stage=0;lane.locked=true;}
    for(const [kind,point,bonus]of [['hurdle',lane.hurdle,25],['hoop',lane.hoop,50]]){
      const key=kind+'Jump';if(lane[key]===jumpSequence||!airborneCrossing(from,to,point,lane.direction,kind==='hoop'))continue;
      lane[key]=jumpSequence;gameState.speedBoostUntil=Math.max(gameState.speedBoostUntil,gameState.runwayRushUntil,now)+750;
      if(gameState.activeOrder){gameState.activeOrder.styleTips+=bonus;popup(`${kind.toUpperCase()} · +${bonus} HUSTLE`,'sale');}
      if(kind==='hurdle'&&lane.stage===1)lane.stage=2;
      else if(kind==='hoop'&&lane.stage===2&&now-lane.startedAt<=4000){lane.stage=0;lane.locked=true;gameState.runwayRushUntil=now+3000;if(gameState.activeOrder)gameState.activeOrder.styleTips+=100;popup('RUNWAY RUSH! · +100 HUSTLE','sale');playSound('perfect');burst(player.position.clone().setY(.5),16,C.gold,'sparkle',.7);}
      updateHUD();
    }
  }
}

function initTownMap() {
  const coordinate=value=>value+20;
  const line=points=>points.map(([x,z])=>`${coordinate(x)},${coordinate(z)}`).join(' ');
  const categoryColours={garments:'#A7DEC9',dyes:'#9ED9F3',motifs:'#FFE291',trims:'#F5B1A2'};
  document.querySelector('#town-map-static').innerHTML=`${TOWN_ROUTES.map(route=>`<polyline points="${line(route)}" fill="none" stroke="#E7C49F" stroke-width="2.4"/>`).join('')}
    <circle cx="20" cy="20" r="2.4" fill="#70CFFF"/>
    ${STUNT_LANES.map(shortcut=>`<polyline points="${line([shortcut.entry,shortcut.exit])}" fill="none" stroke="#7B4DFF" stroke-width=".6" stroke-dasharray=".8 .5"/>`).join('')}
    ${DISTRICTS.map(district=>`<circle cx="${coordinate(district.destination[0])}" cy="${coordinate(district.destination[1])}" r="1.1" fill="#${district.colour.toString(16).padStart(6,'0')}" stroke="#29213D" stroke-width=".35"/><text x="${coordinate(district.destination[0])}" y="${coordinate(district.destination[1])-1.8}" text-anchor="middle">${district.short}</text>`).join('')}
    ${COMPONENT_DEFINITIONS.map(item=>`<g data-supplier-category="${item.category}"><rect x="${coordinate(item.home[0])-1}" y="${coordinate(item.home[1])-1}" width="2" height="2" fill="${categoryColours[item.category]}" stroke="#81788B" stroke-width=".2"/><text x="${coordinate(item.home[0])}" y="${coordinate(item.home[1])+.6}" text-anchor="middle" style="font-size:1.6px;font-weight:900;fill:#29213D">${CATEGORY_SYMBOLS[item.category]}</text></g>`).join('')}
    ${CRAFTING_COUNTERS.map(counter=>`<path d="M${coordinate(counter.point.x)} ${coordinate(counter.point.z)-1}l1 1-1 1-1-1Z" fill="#7B4DFF"/>`).join('')}
    <path id="town-map-shop" d="M${coordinate(SHOP_POINT.x)-1.2} ${coordinate(SHOP_POINT.z)-.2}l1.2-1.2 1.2 1.2v1.5h-2.4Z" fill="#54DDD0" stroke="#29213D" stroke-width=".25"/>`;
}
function updateTownMapAndLabels(now) {
  if(now-lastMapUpdate<100) return;lastMapUpdate=now;
  updateDirection();
  const shopMark=document.querySelector('#town-map-shop');shopMark?.setAttribute('fill',upgradeState().affordable||gameState.shopObjective?'#FFD84A':'#54DDD0');
  const mapPlayer=document.querySelector('#town-map-player'),mapObjective=document.querySelector('#town-map-objective');
  mapPlayer.setAttribute('cx',player.position.x+20);mapPlayer.setAttribute('cy',player.position.z+20);
  const missing=detailedMaterialGuidance()?missingTargetComponent():null;
  const offeredCustomers=gameState.orderOffers.map(offer=>customers.find(customer=>customer.id===offer.customerId));
  document.querySelector('#town-map-orders').innerHTML=offeredCustomers.map(customer=>`<text x="${customer.wrapper.position.x+20}" y="${customer.wrapper.position.z+20}" text-anchor="middle" style="font-size:3px;fill:#7B4DFF">?<title>${customer.name}: order available</title></text>`).join('');
  const target=navigationTarget();
  const objective=target?[target.point.x,target.point.z]:null,caption=target?target.label:gameState.activeOrder?'CHOOSE MATERIALS · '+(touchDevice?'GUIDE':'G FOR GUIDE'):'CHOOSE AN ORDER';
  mapObjective.style.display=objective?'':'none';
  if(objective){mapObjective.setAttribute('cx',objective[0]+20);mapObjective.setAttribute('cy',objective[1]+20);}
  document.querySelector('#town-map-caption').textContent=caption;
  if(objectiveText()!==lastObjective)updateHUD();
  const candidates=readableLabels.map(label=>({label,priority:target?.kind==='counter'&&label.userData.counterId===target.id?6:gameState.shopObjective&&label.element.textContent==='MY SHOP'?8:label.userData.destinationId===gameState.activeOrder?.destinationId?6:1}));
  pickups.forEach(pickup=>candidates.push({label:pickup.label,priority:pickup===missing?8:2}));
  customers.forEach(customer=>{candidates.push({label:customer.bubble.label,priority:customer.id===gameState.activeOrder?.customerId?7:3});if(customer.speechLabel)candidates.push({label:customer.speechLabel,priority:9});});
  const occupied=[];
  const mapRect=document.querySelector('#town-map').getBoundingClientRect();
  const hudRects=[...document.querySelectorAll('.hud-zone,#phone-hud,#phone-timers,#interaction-prompt.visible,#practice-guide:not(.hidden),#bag-full-warning.visible,#joystick,.touch-actions')].filter(element=>element.getClientRects().length&&getComputedStyle(element).visibility!=='hidden').map(element=>element.getBoundingClientRect());
  if(compactMode){
    const centre=player.position.clone().setY(player.position.y+1).project(camera);
    const x=gameViewport.left+(centre.x+1)*gameViewport.width/2,y=gameViewport.top+(1-centre.y)*gameViewport.height/2;
    hudRects.push({left:x-48,right:x+48,top:y-38,bottom:y+48});
  }
  const overlaps=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
  candidates.sort((a,b)=>b.priority-a.priority||horizontalDistance(player.position,a.label.getWorldPosition(new THREE.Vector3()))-horizontalDistance(player.position,b.label.getWorldPosition(new THREE.Vector3())));
  for(const {label,priority} of candidates) {
    const world=label.getWorldPosition(new THREE.Vector3()),distance=horizontalDistance(player.position,world),screen=world.clone().project(camera);
    const width=label.element.offsetWidth||label.element.textContent.length*7+24,height=label.element.offsetHeight||32;
    const x=gameViewport.left+(screen.x+1)*gameViewport.width/2,y=gameViewport.top+(1-screen.y)*gameViewport.height/2;
    const rect={left:x-width/2-4,right:x+width/2+4,top:y-height-4,bottom:y+4};
    const enabled=(!label.element.classList.contains('customer-bubble')&&!label.element.classList.contains('pickup-label'))||label.element.classList.contains('visible');
    const eligible=enabled&&gameState.started&&!gameState.modalOpen&&!gameState.gameOver&&(priority>=6||distance<4)&&screen.z>-1&&screen.z<1&&rect.right>gameViewport.left&&rect.left<gameViewport.left+gameViewport.width&&rect.bottom>gameViewport.top&&rect.top<gameViewport.top+gameViewport.height;
    const visible=eligible&&occupied.length<(compactMode?2:4)&&!occupied.some(other=>overlaps(rect,other))&&!hudRects.some(other=>overlaps(rect,other))&&!(document.querySelector('#town-map').closest('#hud')&&overlaps(rect,mapRect));
    label.element.style.visibility=visible?'visible':'hidden';
    if(visible&&label.element.getBoundingClientRect().width>0)occupied.push(rect);
  }
}
const showcasePlinths = [];
let studioRing;
let shopRing;
let objectiveMarker;
let customerTargetRing;
let stickerKiosk;
let studioBuilding;
let shopBuilding;

function createShopShowcase(parent) {
  [-2.55,-1.42,-.29].forEach((x,index)=>{
    const plinth=new THREE.Group(); plinth.position.set(x,0,3.58); parent.add(plinth);
    mesh(cylinder,materials.cream,[0,.16,0],[.42,.28,.42],plinth);
    const mannequin=new THREE.Group(); plinth.add(mannequin);
    mesh(sphere,mat(0xE7D8CE),[0,1.48,0],[.16,.19,.16],mannequin,false);
    mesh(box,mat(0xE7D8CE),[0,.93,0],[.34,.76,.18],mannequin,false);
    for(const legX of [-.1,.1])mesh(cylinder,mat(0xD6C5BB),[legX,.42,0],[.035,.62,.035],mannequin,false);
    const garmentLayer=new THREE.Group(); garmentLayer.position.set(0,1.02,.13); garmentLayer.scale.setScalar(.65); plinth.add(garmentLayer);
    const plaque=worldLabel('EMPTY'); plaque.element.className='showcase-plaque'; plaque.position.set(0,.18,.48); plinth.add(plaque);
    showcasePlinths.push({garmentLayer,plaque});
  });
  refreshWorldShowcase();
}

function refreshWorldShowcase() {
  showcasePlinths.forEach((plinth,index)=>{
    disposeGeneratedGroup(plinth.garmentLayer);plinth.garmentLayer.clear();
    const entry=gameState.showcase[index];
    if(entry){buildGarmentModel(entry.design,plinth.garmentLayer,false);plinth.plaque.element.textContent=`${entry.design.rarity} · ${briefVerdict(entry.briefFit)}`;}
    else plinth.plaque.element.textContent='EMPTY';
  });
}

function buildWorld() {
  createSky();
  const hemi = new THREE.HemisphereLight(0xCDEEFF, 0x83AF78, 1.32);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xFFF1D6, 2.55);
  sun.position.set(12, 22, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(touchDevice ? 1024 : 2048, touchDevice ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -30, right: 30, top: 30, bottom: -30, near: .5, far: 65 });
  sun.shadow.bias = -.0003;
  scene.add(sun);

  mesh(new THREE.PlaneGeometry(50, 50), materials.grass, [0, -.06, 0], [1, 1, 1]).rotation.x = -Math.PI / 2;
  const hEdge = mesh(new THREE.PlaneGeometry(36, 5.3), materials.pathEdge, [0, -.035, 0], [1, 1, 1]); hEdge.rotation.x = -Math.PI / 2;
  const vEdge = mesh(new THREE.PlaneGeometry(5.3, 36), materials.pathEdge, [0, -.03, 0], [1, 1, 1]); vEdge.rotation.x = -Math.PI / 2;
  const hPath = mesh(new THREE.PlaneGeometry(36, 4.6), materials.path, [0, -.015, 0], [1, 1, 1]); hPath.rotation.x = -Math.PI / 2;
  const vPath = mesh(new THREE.PlaneGeometry(4.6, 36), materials.path, [0, -.01, 0], [1, 1, 1]); vPath.rotation.x = -Math.PI / 2;
  const shopPath = mesh(box, materials.path, [11.25, -.02, 6.5], [10, .04, 3]);
  shopPath.rotation.y = Math.atan2(8.5, 5);
  const plazaEdge = mesh(new THREE.CylinderGeometry(5.8, 5.8, .08, 64), materials.pathEdge, [0, 0, 0], [1, 1, 1]);
  const plaza = mesh(new THREE.CylinderGeometry(5.4, 5.4, .11, 64), materials.path, [0, .035, 0], [1, 1, 1]);
  plazaEdge.receiveShadow = plaza.receiveShadow = true;

  studioBuilding=createFeatureBuilding({ x: -20.5, z: -12, rotation: -2.10, main: materials.lavender, accent: materials.peach, label: 'DESIGN STUDIO', kind: 'studio' });
  shopBuilding=createFeatureBuilding({ x: 20.5, z: 12, rotation: 1.04, main: materials.mint, accent: materials.peach, label: 'MY SHOP', kind: 'shop' });
  studioRing = createFloorRing(STUDIO_POINT, C.lavender);
  shopRing = createFloorRing(SHOP_POINT, C.mint);
  createFlowerCluster(-17.9, -7.7); createFlowerCluster(-15.7, -12.2); createFlowerCluster(-18.1, -14.8);
  createFlowerCluster(16.8, 13.6);

  [[-11,-21],[0,-21],[11,-21],[-21,2],[-21,12],[21,-5]].forEach((p, i) => createBackgroundBuilding(p[0], p[1], i));
  createTree(-19, 13, true); createTree(-10.5, 19); createTree(-19, 8.5);
  createFlowerCluster(-10.3, 10.2); createFlowerCluster(-13, 11.8);
  createFence(-13.2, 19, .05, 5); createFence(-19.7, 12.3, Math.PI / 2, 4.6);
  createTree(19, -13, true); createTree(19, -9); createTree(10.5, -19);
  createFence(19.7, -14, Math.PI / 2, 5); createFence(12.2, -19, 0, 4.5);
  createFlowerCluster(12.2, -12.8); createFlowerCluster(15.6, -11.8);

  objectiveMarker = mesh(new THREE.OctahedronGeometry(.42), mat(C.yellow, { emissive: C.gold, emissiveIntensity: .3 }), [0, -10, 0], [1, 1, 1]);
  createDumpster(-17, 14, 'A');
  createDumpster(13, -10, 'B');
  createTownLife();

  buildDeliveryTown();
}

// 9. player creation
const player = new THREE.Group();
player.position.set(-4, 0, -4);
scene.add(player);
let playerBody;
let carriedDesign = null;
let playerAnimation = null;

function findClip(clips, type) {
  const lowered = clips.map(clip => ({ clip, name: clip.name.toLowerCase() }));
  if (type === 'walk') return lowered.find(item => item.name === 'walk')?.clip || lowered.find(item => item.name.includes('walk'))?.clip;
  return lowered.find(item => item.name.includes(type))?.clip;
}

function normalizeCharacter(model, targetHeight) {
  model.traverse(item => {
    if (item.isMesh) {
      item.castShadow = true;
      item.receiveShadow = true;
      const characterMaterials = Array.isArray(item.material) ? item.material : [item.material];
      characterMaterials.forEach(material => { if (material?.map) material.map.colorSpace = THREE.SRGBColorSpace; });
    }
  });
  let bounds = new THREE.Box3().setFromObject(model);
  const height = Math.max(.001, bounds.max.y - bounds.min.y);
  model.scale.setScalar(targetHeight / height);
  bounds = new THREE.Box3().setFromObject(model);
  model.position.y -= bounds.min.y;
}

function prepareAnimatedCharacter(gltf, wrapper, targetHeight) {
  const model = gltf.scene;
  normalizeCharacter(model, targetHeight);
  wrapper.add(model);
  const mixer = new THREE.AnimationMixer(model);
  const clips = gltf.animations;
  const idleClip = findClip(clips, 'idle');
  const walkClip = findClip(clips, 'walk');
  const celebrationClip = findClip(clips, 'emote-yes');
  const angryClip = findClip(clips, 'emote-no');
  const jumpClip = findClip(clips, 'jump');
  const sprintClip=wrapper===player?findClip(clips,'sprint'):null;
  const actions = {
    idle: idleClip ? mixer.clipAction(idleClip) : null,
    walk: walkClip ? mixer.clipAction(walkClip) : null,
    celebrate: celebrationClip ? mixer.clipAction(celebrationClip) : null,
    angry: angryClip ? mixer.clipAction(angryClip) : null,
    jump: jumpClip ? mixer.clipAction(jumpClip) : null,
    sprint:sprintClip?mixer.clipAction(sprintClip):null
  };
  let current = null;
  const play = (name, fade = .18) => {
    const next = actions[name] || actions.idle;
    if (!next || next === current) return;
    next.enabled = true;
    next.reset().play();
    if (current) current.crossFadeTo(next, fade, true);
    current = next;
  };
  play('idle', 0);
  return { model, mixer, actions, play, get current() { return current; } };
}

async function createPlayer() {
  const gltf = await loader.loadAsync('assets/third_party/kenney-mini-characters/Models/GLB%20format/character-female-a.glb');
  playerAnimation = prepareAnimatedCharacter(gltf, player, 1.62);
  playerBody = playerAnimation.model;
}

// 10. player movement
const keys = new Set();
const velocity = new THREE.Vector3();
const inputDirection = new THREE.Vector3();
const cameraForward = new THREE.Vector3();
const cameraRight = new THREE.Vector3();
const worldUp = new THREE.Vector3(0, 1, 0);
const JUMP_DURATION = .62;
const JUMP_HEIGHT = .72;
const JUMP_COOLDOWN = 150;
let currentSpeed = 0;
let jumping = false;
let jumpSequence=0;const previousStuntPosition=new THREE.Vector3();
let jumpElapsed = 0;
let jumpCooldownUntil = 0;
const jumpStartPosition = new THREE.Vector2();
let jumpTakeoffSpeed = 0;
let jumpOrderCustomerId = null;
window.addEventListener('keydown', event => {
  if(event.code==='Space'&&gameState.modalOpen==='design'&&craftChallenge){event.preventDefault();if(!event.repeat&&!simulationSuspended())stopCraftChallenge();return;}
  if(gameState.modalOpen==='results'&&!simulationSuspended()){if(['Space','Enter','KeyE'].includes(event.code)&&!event.repeat){event.preventDefault();if(document.activeElement?.id==='visit-shop'&&event.code!=='KeyE')continueSale(true);else continueSale();}return;}
  if(event.code==='KeyG'&&!event.repeat){activateGuide();return;}
  if(event.code==='KeyO'&&!event.repeat){openOrderBoard();return;}
  if(event.code==='KeyP'&&!event.repeat){setManualPause(!manualPaused);return;}
  if(simulationSuspended())return;
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','KeyW','KeyA','KeyS','KeyD','Space'].includes(event.code)) event.preventDefault();
  keys.add(event.code);
  if (event.code === 'KeyE' && !event.repeat) handleInteraction();
  if (event.code === 'Space' && !event.repeat) startJump();
  if (event.code === 'KeyQ' && !event.repeat) quickDrop();
  if (event.code === 'KeyB' && !event.repeat) toggleBag();
  if (event.code === 'Escape' && gameState.modalOpen) closeModal(gameState.modalOpen);
});
window.addEventListener('keyup', event => keys.delete(event.code));

function startJump() {
  if (simulationSuspended() || !gameState.started || gameState.gameOver || gameState.modalOpen || saleGameplayPaused() || jumping || gameNow() < jumpCooldownUntil) return;
  jumping = true;jumpSequence++;
  jumpElapsed = 0;
  jumpStartPosition.set(player.position.x, player.position.z);
  jumpTakeoffSpeed = currentSpeed;
  jumpOrderCustomerId = gameState.activeOrder?.customerId || null;
  const jumpAction = playerAnimation?.actions.jump;
  if (jumpAction) {
    jumpAction.setLoop(THREE.LoopOnce, 1);
    jumpAction.clampWhenFinished = true;
    playerAnimation.play('jump', .1);
  }
}

function updateJump(dt) {
  if (!jumping) {
    player.position.y = 0;
    return;
  }
  jumpElapsed = Math.min(JUMP_DURATION, jumpElapsed + dt);
  const progress = jumpElapsed / JUMP_DURATION;
  player.position.y = 4 * JUMP_HEIGHT * progress * (1 - progress);
  if (progress >= 1) {
    jumping = false;
    player.position.y = 0;
    // A released movement key can land a hop on a rail; settle beside it rather than trapping the player.
    for(const rail of solidFootprints.filter(item=>item.jumpable)) {
      if(!collides(player.position.x,player.position.z))break;
      const c=Math.cos(rail.rotation),s=Math.sin(rail.rotation),dx=player.position.x-rail.x,dz=player.position.z-rail.z;
      const localX=c*dx-s*dz,localZ=s*dx+c*dz;
      if(Math.abs(localX)>rail.width/2+PLAYER_RADIUS||Math.abs(localZ)>rail.depth/2+PLAYER_RADIUS)continue;
      for(const sign of [Math.sign(localZ)||1,-(Math.sign(localZ)||1)]) {
        const z=sign*(rail.depth/2+PLAYER_RADIUS+.05),x=rail.x+c*localX+s*z,worldZ=rail.z-s*localX+c*z;
        if(!collides(x,worldZ)){player.position.x=x;player.position.z=worldZ;break;}
      }
    }
    jumpCooldownUntil = gameNow() + JUMP_COOLDOWN;
    rewardStyleHop(gameNow());
  }
}

function rewardStyleHop() { /* Free-space jumps earn no Hustle. */ }

function collides(x, z, allowJump = false) {
  if(treeBlockers.some(t => Math.hypot(x-t.x,z-t.z)<PLAYER_RADIUS+t.radius)) return true;
  return solidFootprints.some(item=>{
    if(item.jumpable&&allowJump&&jumping&&player.position.y>.4)return false;
    const dx=x-item.x,dz=z-item.z,c=Math.cos(item.rotation),s=Math.sin(item.rotation);
    const localX=c*dx-s*dz, localZ=s*dx+c*dz;
    return Math.hypot(Math.max(0,Math.abs(localX)-item.width/2),Math.max(0,Math.abs(localZ)-item.depth/2))<PLAYER_RADIUS;
  });
}
function updateMovement(dt) {
  if(simulationSuspended())return;
  if (!gameState.started || gameState.gameOver || gameState.modalOpen || saleGameplayPaused()) {
    velocity.x = THREE.MathUtils.damp(velocity.x, 0, 28, dt);
    velocity.z = THREE.MathUtils.damp(velocity.z, 0, 28, dt);
  } else {
    const horizontalInput = touchInput.x + (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
    const verticalInput = -touchInput.y + (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0);
    cameraForward.copy(cameraTarget).sub(camera.position).setY(0).normalize();
    cameraRight.crossVectors(cameraForward, worldUp).normalize();
    inputDirection.copy(cameraForward).multiplyScalar(verticalInput).addScaledVector(cameraRight, horizontalInput);
    if (inputDirection.lengthSq() > 1) inputDirection.normalize();
    const boost=boostMultiplier();
    const desiredX = inputDirection.x * TOP_SPEED * boost;
    const desiredZ = inputDirection.z * TOP_SPEED * boost;
    const lambda = inputDirection.lengthSq() ? 18 : 28;
    velocity.x = THREE.MathUtils.damp(velocity.x, desiredX, lambda, dt);
    velocity.z = THREE.MathUtils.damp(velocity.z, desiredZ, lambda, dt);
  }
  previousStuntPosition.copy(player.position);
  const nx = THREE.MathUtils.clamp(player.position.x + velocity.x * dt, -PLAYER_BOUNDS, PLAYER_BOUNDS);
  if (!collides(nx, player.position.z,true)) player.position.x = nx; else velocity.x = 0;
  const nz = THREE.MathUtils.clamp(player.position.z + velocity.z * dt, -PLAYER_BOUNDS, PLAYER_BOUNDS);
  if (!collides(player.position.x, nz,true)) player.position.z = nz; else velocity.z = 0;
  currentSpeed = Math.hypot(velocity.x, velocity.z);
  if (currentSpeed > .12) {
    const targetAngle = Math.atan2(velocity.x, velocity.z);
    let diff = targetAngle - player.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    player.rotation.y += diff * (1 - Math.exp(-16 * dt));
  }
  updateJump(dt);
  if (playerAnimation) {
    if (!jumping || !playerAnimation.actions.jump) playerAnimation.play(currentSpeed>.12?(gameState.activePlayTime*1000<gameState.runwayRushUntil?'sprint':'walk'):'idle');
    if (playerAnimation.actions.walk) playerAnimation.actions.walk.timeScale = THREE.MathUtils.clamp(currentSpeed / TOP_SPEED, .8, 1.15);
  }
}

function updateCamera(dt) {
  if (!gameState.started) {
    camera.position.set(TITLE_CAMERA.x, TITLE_CAMERA.y + Math.sin(elapsed * .45) * .18, TITLE_CAMERA.z);
    camera.lookAt(0, 1, 0);
    return;
  }
  const moveLead = currentSpeed > .1 ? velocity.clone().normalize().multiplyScalar(.65) : new THREE.Vector3();
  const desiredTarget = new THREE.Vector3(player.position.x, 1, player.position.z).add(moveLead);
  const desiredPosition = new THREE.Vector3(player.position.x + CAMERA_OFFSET.x, CAMERA_OFFSET.y, player.position.z + CAMERA_OFFSET.z);
  if(cameraCelebration){
    const age=gameNow()-cameraCelebration.start;
    if(age>=cameraCelebration.duration)cameraCelebration=null;
    else{
      const strength=age<250?THREE.MathUtils.smoothstep(age/250,0,1):1-THREE.MathUtils.smoothstep((age-250)/(cameraCelebration.duration-250),0,1);
      const focus=cameraCelebration.customer.wrapper.position.clone().lerp(player.position,.45).setY(1.05);
      desiredTarget.lerp(focus,strength*.72);
      desiredPosition.lerp(focus.clone().add(CAMERA_OFFSET.clone().multiplyScalar(.72)),strength*.48);
    }
  }
  if (titleTransitionElapsed < .7) {
    titleTransitionElapsed += dt;
    const t = THREE.MathUtils.smoothstep(Math.min(titleTransitionElapsed / .7, 1), 0, 1);
    camera.position.lerpVectors(titleStartCamera, desiredPosition, t);
    cameraTarget.lerp(desiredTarget, 1 - Math.exp(-8 * dt));
  } else {
    camera.position.x = THREE.MathUtils.damp(camera.position.x, desiredPosition.x, 6.5, dt);
    camera.position.y = THREE.MathUtils.damp(camera.position.y, desiredPosition.y, 6.5, dt);
    camera.position.z = THREE.MathUtils.damp(camera.position.z, desiredPosition.z, 6.5, dt);
    cameraTarget.x = THREE.MathUtils.damp(cameraTarget.x, desiredTarget.x, 8, dt);
    cameraTarget.y = THREE.MathUtils.damp(cameraTarget.y, desiredTarget.y, 8, dt);
    cameraTarget.z = THREE.MathUtils.damp(cameraTarget.z, desiredTarget.z, 8, dt);
  }
  camera.lookAt(cameraTarget);
}

// 11. townspeople
const customers = [];
function customerRequest(customer) { return gameState.activeOrder?.customerId===customer.id?gameState.activeOrder:offerForCustomer(customer.id)||null; }
function requestSymbol(motif) { return { STAR:'★', HEART:'♥', FLOWER:'✿' }[motif]; }
function iconMarkup(name, className = '') { return `<svg class="${className}" aria-hidden="true"><use href="#icon-${name.toLowerCase()}"></use></svg>`; }
function customerPortraitMarkup(customer) {
  const portrait=customer.portrait||{skin:'#D99A6C',hair:'#5A352D',shirt:'#7B4DFF'};
  return `<span class="customer-avatar" aria-hidden="true"><svg viewBox="0 0 48 48"><rect width="48" height="48" fill="#54DDD0"/><path d="M8 48c2-12 9-17 16-17s14 5 16 17" fill="${portrait.shirt}"/><circle cx="24" cy="22" r="13" fill="${portrait.skin}" stroke="#29213D" stroke-width="2"/><path d="M11 20C10 7 18 4 25 5c9 0 14 7 12 17-4-7-8-8-13-9-4 5-8 7-13 7Z" fill="${portrait.hair}" stroke="#29213D" stroke-width="2"/><circle cx="19" cy="23" r="1.5" fill="#29213D"/><circle cx="29" cy="23" r="1.5" fill="#29213D"/><path d="M20 28c3 2 5 2 8 0" fill="none" stroke="#29213D" stroke-width="1.8" stroke-linecap="round"/></svg></span>`;
}
function requestIconsMarkup(request) {
  const garment={DRESS:'dress',TOP:'top',SKIRT:'skirt'}[request.garmentType];
  const motif={STAR:'star',HEART:'heart',FLOWER:'flower'}[request.motif];
  const trim={BOW:'bow',BELT:'belt',RUFFLE:'ruffle'}[request.trim];
  const swatch=SWATCHES[request.colour]||'#7B4DFF';
  return `<span class="order-icons"><i class="order-icon">${iconMarkup(garment)}</i><i class="order-swatch" style="--order-swatch:${swatch}"></i><i class="order-icon">${iconMarkup(motif)}</i><i class="order-icon">${iconMarkup(trim)}</i></span>`;
}
function componentVisualMarkup(category, type) {
  if(category==='dyes')return `<i class="order-swatch" style="--order-swatch:${SWATCHES[type]||'#7B4DFF'}"></i>`;
  const icon=category==='garments'?{DRESS:'dress',TOP:'top',SKIRT:'skirt'}[type]:category==='motifs'?{STAR:'star',HEART:'heart',FLOWER:'flower'}[type]:{BOW:'bow',BELT:'belt',RUFFLE:'ruffle'}[type];
  return iconMarkup(icon);
}

function createRequestBubble(definition) {
  const element = document.createElement('div');
  element.className = 'customer-bubble';
  element.innerHTML = `${customerPortraitMarkup(definition)}<strong>${definition.name.toUpperCase()}</strong><span></span>`;
  const label = new CSS2DObject(element);
  label.position.set(0, 2.1, 0);
  return { element, label };
}

function refreshCustomerBubble(customer) {
  const request = customerRequest(customer);
  const offer = offerForCustomer(customer.id);
  const selected = gameState.activeOrder?.customerId === customer.id;
  const showAnnoyance = gameNow() < customer.annoyanceVisibleUntil || gameNow() < customer.fumingUntil;
  const annoyanceClass = customer.annoyance >= 3 ? 'scribble' : customer.annoyance === 2 ? 'exclaim' : 'squiggle';
  const annoyance = showAnnoyance && customer.annoyance > 0 ? `<i class="annoyance-indicator ${annoyanceClass}"><b></b><b></b><b></b></i>` : '';
  const recipeLine = request ? briefMarkup(customer.id) : '';
  const destination=DISTRICTS.find(item=>item.id===(offer?.destinationId||(selected?gameState.activeOrder.destinationId:null)));
  const status = offer ? `<small class="order-available">ORDER AVAILABLE</small><small class="difficulty ${offer.difficultyClass}">${offer.difficulty}</small>` : selected ? '<small class="target-tag">YOUR CUSTOMER</small>' : '';
  const markup=`${annoyance}${customerPortraitMarkup(customer)}<strong>${customer.name.toUpperCase()}</strong>${status}${recipeLine}${destination?`<small class="bubble-destination">→ ${destination.short}</small>`:''}`;
  if(customer.bubble.markup!==markup){customer.bubble.element.innerHTML=markup;customer.bubble.markup=markup;}
  customer.bubble.element.classList.toggle('selected', selected);
  customer.bubble.element.classList.toggle('visible', gameState.started && Boolean(request) && (selected || horizontalDistance(player.position,customer.wrapper.position) <= 7));
}

function customerPatrolRoute(points) {
  const route=[points[0]];
  points.forEach((point,index)=>route.push(...walkingPath(point,points[(index+1)%points.length]).slice(1)));
  route.pop();return route;
}
function addCustomerAccessory(customer,wrapper) {
  if(!customer.role) return;
  const accessory=new THREE.Group();wrapper.add(accessory);
  if(customer.role==='baker') {
    mesh(cylinder,materials.cream,[0,1.57,0],[.23,.25,.23],accessory,false);
    for(let i=-1;i<=1;i++) mesh(sphere,materials.cream,[i*.13,1.78,0],[.18,.16,.18],accessory,false);
  } else if(customer.role==='skater') {
    mesh(box,materials.sky,[0,.8,-.25],[.3,.85,.1],accessory,false);
    for(const y of [.51,1.1])for(const x of [-.14,.14])mesh(sphere,materials.ink,[x,y,-.32],[.07,.07,.07],accessory,false);
  } else if(customer.role==='florist') {
    for(let i=0;i<3;i++){mesh(cylinder,materials.leaf,[.37,.85+i*.06,-.05],[.02,.55,.02],accessory,false);mesh(sphere,[materials.coral,materials.yellow,materials.peach][i],[.32+i*.07,1.12+i*.06,-.05],[.1,.1,.1],accessory,false);}
  } else if(customer.role==='duck keeper') {
    mesh(cylinder,materials.yellow,[0,1.56,0],[.3,.07,.3],accessory,false);
    mesh(sphere,materials.yellow,[0,1.67,0],[.2,.13,.2],accessory,false);
    mesh(box,materials.peach,[0,1.65,.23],[.18,.06,.16],accessory,false);
  } else {
    mesh(new THREE.ConeGeometry(.23,.5,6),materials.coral,[0,1.78,0],[1,1,1],accessory,false);
    mesh(sphere,materials.gold,[0,2.07,0],[.09,.09,.09],accessory,false);
  }
}
function updateCustomerDelivery(customer,dt) {
  const order=gameState.activeOrder;
  if(order?.customerId!==customer.id) return false;
  const destination=DISTRICTS.find(item=>item.id===order.destinationId).destination;
  if(customer.atDestination&&horizontalDistance(customer.wrapper.position,destination)>.1) {
    customer.deliveryPath=walkingPath(customer.wrapper.position,destination).slice(1);customer.deliveryIndex=0;customer.atDestination=false;
  }
  const target=customer.deliveryPath?.[customer.deliveryIndex];
  if(target) {
    const dx=target[0]-customer.wrapper.position.x,dz=target[1]-customer.wrapper.position.z,distance=Math.hypot(dx,dz);
    const step=Math.min(distance,TOP_SPEED*dt);
    if(distance>0){customer.wrapper.position.x+=dx/distance*step;customer.wrapper.position.z+=dz/distance*step;customer.wrapper.rotation.y=Math.atan2(dx,dz);}
    if(distance<=step+.01) customer.deliveryIndex++;
    customer.animation.play('walk');
  } else {
    customer.atDestination=true;customer.animation.play('idle');
    if(horizontalDistance(player.position,customer.wrapper.position)<4)customer.wrapper.rotation.y=Math.atan2(player.position.x-customer.wrapper.position.x,player.position.z-customer.wrapper.position.z);
  }
  customer.animation.mixer.update(dt);refreshCustomerBubble(customer);return true;
}

async function createCustomers() {
  for (let index = 0; index < CUSTOMER_DEFINITIONS.length; index++) {
    const definition = CUSTOMER_DEFINITIONS[index];
    const wrapper = new THREE.Group();
    wrapper.position.set(definition.route[0][0], 0, definition.route[0][1]);
    scene.add(wrapper);
    const gltf = await loader.loadAsync(definition.model);
    const animation = prepareAnimatedCharacter(gltf, wrapper, definition.height);
    addCustomerAccessory(definition,wrapper);
    const bubble = createRequestBubble(definition);
    wrapper.add(bubble.label);
    customers.push({
      ...definition, route:customerPatrolRoute(definition.route), wrapper, animation, bubble, routeIndex:1,
      deliveryPath:[],deliveryIndex:0,atDestination:false,
      pauseDuration:CUSTOMER_PAUSES[index % CUSTOMER_PAUSES.length], pausedUntil:0,
      reactionUntil:0, resumeAt:0, sellingPaused:false, inspectUntil:0,
      annoyance:0, annoyanceVisibleUntil:0, fumingUntil:0, chaseUntil:0,
      rejectionCount:0, goAwayShown:false, countedAnnoyed:false
    });
  }
}

function updateCustomers(dt, now) {
  if(saleGameplayPaused(now)){
    customers.forEach(customer=>{if(customer===saleCelebrationCustomer)customer.animation.mixer.update(dt);refreshCustomerBubble(customer);});
    return;
  }
  if (!gameState.started || gameState.gameOver || gameState.modalOpen) {
    customers.forEach(customer => { customer.animation.play('idle'); customer.animation.mixer.update(dt); refreshCustomerBubble(customer); });
    return;
  }
  for (const customer of customers) {
    const playerDistance = player.position.distanceTo(customer.wrapper.position);
    if (customer.fumingUntil) {
      if (now >= customer.fumingUntil) {
        customer.fumingUntil = 0; customer.chaseUntil = 0; customer.annoyance = 1; customer.goAwayShown = false;
        if(gameState.activeOrder?.customerId===customer.id) {
          customer.deliveryPath=walkingPath(customer.wrapper.position,DISTRICTS.find(item=>item.id===gameState.activeOrder.destinationId).destination).slice(1);
          customer.deliveryIndex=0;customer.atDestination=false;
        }
        customer.routeIndex = customer.route.reduce((best, point, index) => {
          const distance = Math.hypot(customer.wrapper.position.x - point[0], customer.wrapper.position.z - point[1]);
          return distance < best.distance ? { index, distance } : best;
        }, { index:0, distance:Infinity }).index;
      } else {
        if (now < customer.chaseUntil) {
          const dx=player.position.x-customer.wrapper.position.x, dz=player.position.z-customer.wrapper.position.z, distance=Math.max(.001,Math.hypot(dx,dz));
          const nextX=THREE.MathUtils.clamp(customer.wrapper.position.x+dx/distance*2.8*dt,-PLAYER_BOUNDS,PLAYER_BOUNDS);
          if(!collides(nextX,customer.wrapper.position.z))customer.wrapper.position.x=nextX;
          const nextZ=THREE.MathUtils.clamp(customer.wrapper.position.z+dz/distance*2.8*dt,-PLAYER_BOUNDS,PLAYER_BOUNDS);
          if(!collides(customer.wrapper.position.x,nextZ))customer.wrapper.position.z=nextZ;
          customer.wrapper.rotation.y=Math.atan2(dx,dz); customer.animation.play('walk');
          if(distance<.9&&!customer.goAwayShown){customer.goAwayShown=true;showCustomerSpeech(customer,'GO AWAY!',1100);}
        } else customer.animation.play('idle');
        customer.animation.mixer.update(dt); refreshCustomerBubble(customer); continue;
      }
    }
    if (customer.inspectUntil && now < customer.inspectUntil) {
      const dx=player.position.x-customer.wrapper.position.x, dz=player.position.z-customer.wrapper.position.z;
      customer.wrapper.rotation.y=Math.atan2(dx,dz); customer.animation.play('idle'); customer.animation.mixer.update(dt); refreshCustomerBubble(customer); continue;
    }
    if (customer.reactionUntil && now < customer.reactionUntil && !customer.resumeAt) {
      customer.wrapper.rotation.z=Math.sin(now*.025)*.08; customer.animation.mixer.update(dt); refreshCustomerBubble(customer); continue;
    } else if (customer.wrapper.rotation.z) customer.wrapper.rotation.z=0;
    if (customer.resumeAt) {
      if (now < customer.resumeAt) {
        const dx = player.position.x - customer.wrapper.position.x;
        const dz = player.position.z - customer.wrapper.position.z;
        const faceAngle = Math.atan2(dx, dz);
        const faceDiff = Math.atan2(Math.sin(faceAngle - customer.wrapper.rotation.y), Math.cos(faceAngle - customer.wrapper.rotation.y));
        customer.wrapper.rotation.y += faceDiff * (1 - Math.exp(-8 * dt));
        customer.animation.mixer.update(dt);
        refreshCustomerBubble(customer);
        continue;
      }
      customer.resumeAt = 0;
      customer.reactionUntil = 0;
      customer.sellingPaused = false;
      if(gameState.activeOrder?.customerId!==customer.id) {
        const definition=CUSTOMER_DEFINITIONS.find(item=>item.id===customer.id);
        customer.route=customerPatrolRoute([[customer.wrapper.position.x,customer.wrapper.position.z],...definition.route]);customer.routeIndex=1;
      }
      customer.animation.play('walk');
    }
    const isDeliveryTarget = gameState.hasFinishedDesign && gameState.activeOrder?.customerId === customer.id;
    if (isDeliveryTarget && customer.atDestination && playerDistance <= 1.65) customer.sellingPaused = true;
    else if (!isDeliveryTarget || playerDistance > 2.4) customer.sellingPaused = false;
    if (customer.sellingPaused) {
      const dx = player.position.x - customer.wrapper.position.x;
      const dz = player.position.z - customer.wrapper.position.z;
      const faceAngle = Math.atan2(dx, dz);
      const faceDiff = Math.atan2(Math.sin(faceAngle - customer.wrapper.rotation.y), Math.cos(faceAngle - customer.wrapper.rotation.y));
      customer.wrapper.rotation.y += faceDiff * (1 - Math.exp(-8 * dt));
      customer.animation.play('idle');
      customer.animation.mixer.update(dt);
      refreshCustomerBubble(customer);
      continue;
    }
    if(updateCustomerDelivery(customer,dt)) continue;
    const target = customer.route[customer.routeIndex];
    if (now < customer.pausedUntil) {
      customer.animation.play('idle');
    } else {
      const dx = target[0] - customer.wrapper.position.x;
      const dz = target[1] - customer.wrapper.position.z;
      const distance = Math.hypot(dx, dz);
      if (distance <= .25) {
        customer.wrapper.position.x = target[0];
        customer.wrapper.position.z = target[1];
        customer.routeIndex = (customer.routeIndex + 1) % customer.route.length;
        customer.pausedUntil = now + customer.pauseDuration * 1000;
        customer.animation.play('idle');
      } else {
        const step = Math.min(distance, 1.25 * dt);
        customer.wrapper.position.x += dx / distance * step;
        customer.wrapper.position.z += dz / distance * step;
        const targetAngle = Math.atan2(dx, dz);
        let diff = Math.atan2(Math.sin(targetAngle - customer.wrapper.rotation.y), Math.cos(targetAngle - customer.wrapper.rotation.y));
        customer.wrapper.rotation.y += diff * (1 - Math.exp(-8 * dt));
        customer.animation.play('walk');
      }
    }
    customer.animation.mixer.update(dt);
    refreshCustomerBubble(customer);
  }
}

// 12. pickups
const pickups = [];
const temporaryDrops = [];
const collectionHistory = [];
const componentId = (category, type) => `${category}:${type}`;
const componentFromId = id => {
  const [category, type] = id.split(':');
  return { category, type };
};
function componentMaterial(definition) {
  if (definition.category === 'dyes') return materials[definition.type.toLowerCase()];
  return { garments:materials.mint, motifs:materials.yellow, trims:materials.peach }[definition.category];
}
function flowerPetalShape() {
  const petal = new THREE.Shape();
  petal.moveTo(0, 0);
  petal.bezierCurveTo(-.17, .08, -.16, .3, 0, .38);
  petal.bezierCurveTo(.16, .3, .17, .08, 0, 0);
  petal.closePath();
  return petal;
}
function pickupHeartShape() {
  const shape=new THREE.Shape(); shape.moveTo(0,-.3); shape.bezierCurveTo(-.52,-.02,-.42,.4,0,.2); shape.bezierCurveTo(.42,.4,.52,-.02,0,-.3); shape.closePath(); return shape;
}
function garmentPickupShape(type) {
  const shape=new THREE.Shape();
  if(type==='TOP'){
    shape.moveTo(-.18,.48);shape.lineTo(-.42,.42);shape.lineTo(-.63,.19);shape.lineTo(-.45,.02);shape.lineTo(-.34,.13);shape.lineTo(-.34,-.4);shape.lineTo(.34,-.4);shape.lineTo(.34,.13);shape.lineTo(.45,.02);shape.lineTo(.63,.19);shape.lineTo(.42,.42);shape.lineTo(.18,.48);shape.quadraticCurveTo(0,.3,-.18,.48);
  }else if(type==='DRESS'){
    shape.moveTo(-.18,.6);shape.lineTo(-.38,.5);shape.lineTo(-.34,.08);shape.lineTo(-.67,-.62);shape.lineTo(.67,-.62);shape.lineTo(.34,.08);shape.lineTo(.38,.5);shape.lineTo(.18,.6);shape.quadraticCurveTo(0,.43,-.18,.6);
  }else{
    shape.moveTo(-.35,.28);shape.lineTo(.35,.28);shape.lineTo(.55,-.55);shape.lineTo(-.55,-.55);shape.closePath();
  }
  shape.closePath(); return shape;
}
function addPickupHanger(parent,y) {
  const hanger=mesh(new THREE.TorusGeometry(.2,.025,7,18,Math.PI),materials.cream,[0,y+.16,0],[1,1,.65],parent,false); hanger.rotation.z=Math.PI;
  const left=mesh(cylinder,materials.cream,[-.18,y-.02,0],[.022,.38,.022],parent,false);left.rotation.z=-1.05;
  const right=mesh(cylinder,materials.cream,[.18,y-.02,0],[.022,.38,.022],parent,false);right.rotation.z=1.05;
}
function buildComponentVisual(definition, parent) {
  const material = componentMaterial(definition);
  if (definition.category === 'garments') {
    const geometry=new THREE.ExtrudeGeometry(garmentPickupShape(definition.type),{depth:.12,bevelEnabled:true,bevelSize:.025,bevelThickness:.025,bevelSegments:2});
    const garment=mesh(geometry,material,[0,definition.type==='DRESS'?.08:definition.type==='SKIRT'?.05:0,-.06],[1,1,1],parent);
    if(definition.type==='SKIRT')mesh(box,materials.cream,[0,.31,.02],[.74,.1,.17],parent);
    else addPickupHanger(parent,definition.type==='DRESS'?.78:.61);
  } else if (definition.category === 'dyes') {
    mesh(cylinder,material,[0,-.03,0],[.25,.52,.25],parent);
    mesh(cylinder,materials.cream,[0,.32,0],[.13,.18,.13],parent);
    mesh(cylinder,materials.ink,[0,.46,0],[.16,.1,.16],parent);
  } else if (definition.category === 'motifs') {
    const extrude={depth:.08,bevelEnabled:true,bevelSize:.018,bevelThickness:.018,bevelSegments:2};
    if (definition.type === 'FLOWER') {
      for (let index = 0; index < 5; index++) {
        const angle = index * Math.PI * 2 / 5;
        const back=mesh(new THREE.ExtrudeGeometry(flowerPetalShape(),extrude),materials.cream,[Math.cos(angle)*.11,Math.sin(angle)*.11,-.02],[1.17,1.17,1],parent);back.rotation.z=angle-Math.PI/2;
        const petal = mesh(new THREE.ExtrudeGeometry(flowerPetalShape(),extrude), index % 2 ? materials.lavender : materials.peach, [Math.cos(angle) * .11, Math.sin(angle) * .11, .07], [1,1,1], parent);
        petal.rotation.z = angle - Math.PI / 2;
      }
      mesh(new THREE.CylinderGeometry(.15,.15,.08,24),materials.cream,[0,0,.02],[1.18,1,1.18],parent).rotation.x=Math.PI/2;
      mesh(new THREE.CylinderGeometry(.13,.13,.08,24),materials.yellow,[0,0,.12],[1,1,1],parent).rotation.x=Math.PI/2;
    } else {
      const shape=definition.type==='HEART'?pickupHeartShape():starShape(.38,.16);
      mesh(new THREE.ExtrudeGeometry(shape,extrude),materials.cream,[0,0,-.03],[1.16,1.16,1],parent);
      mesh(new THREE.ExtrudeGeometry(shape,extrude),definition.type==='HEART'?materials.coral:materials.yellow,[0,0,.08],[1,1,1],parent);
    }
  } else if (definition.type === 'BOW') {
    mesh(sphere,material,[-.2,0,0],[.24,.13,.09],parent); mesh(sphere,material,[.2,0,0],[.24,.13,.09],parent); mesh(sphere,materials.yellow,[0,0,.04],[.09,.09,.08],parent);
  } else if (definition.type === 'BELT') {
    const belt=mesh(new THREE.TorusGeometry(.3,.07,8,18),material,[0,0,0],[1,.55,1],parent); belt.rotation.x=Math.PI/2;
    mesh(box,materials.yellow,[.31,0,.02],[.16,.18,.07],parent);
  } else {
    for(let i=0;i<5;i++) mesh(sphere,material,[-.32+i*.16,Math.sin(i*Math.PI)*.04,0],[.12,.09,.08],parent);
  }
}
function pickupLabelText(definition){if(definition.category==='dyes')return `${definition.type} DYE`;if(definition.category==='motifs')return `${definition.type} PATCH`;return definition.type;}
const CATEGORY_SYMBOLS=Object.freeze({garments:'G',dyes:'D',motifs:'M',trims:'T'});
function categoryIcon(category){return `<i class="category-icon" aria-hidden="true">${CATEGORY_SYMBOLS[category]||''}</i>`;}
function createPickupOutline(visual) {
  const outline=visual.clone(true); const outlineMaterial=new THREE.MeshBasicMaterial({color:C.gold,side:THREE.BackSide,depthWrite:false});
  outline.traverse(child=>{if(child.isMesh){child.material=outlineMaterial;child.scale.multiplyScalar(1.09);child.castShadow=false;child.receiveShadow=false;}});
  outline.visible=false; return outline;
}
function createComponentPickup(definition, index) {
  const g = new THREE.Group();
  g.position.set(definition.home[0], 0, definition.home[1]);
  const pad=mesh(new THREE.CircleGeometry(.72,24),materials.cream,[0,.045,0],[1,1,1],g,false);pad.rotation.x=-Math.PI/2;
  const visual=new THREE.Group(); buildComponentVisual(definition,visual); const outline=createPickupOutline(visual); g.add(outline,visual);
  visual.position.y=.8;outline.position.y=.8;
  const pedestal=mesh(new THREE.CylinderGeometry(.52,.56,.11,28),materials.cream,[0,.09,0],[1,1,1],g,false);
  const ring=mesh(new THREE.RingGeometry(.39,.51,28),new THREE.MeshBasicMaterial({color:componentMaterial(definition).color,transparent:true,opacity:.62,side:THREE.DoubleSide,depthWrite:false}),[0,.155,0],[1,1,1],g,false); ring.rotation.x=-Math.PI/2;
  const sparkles=[[-.43,.35,0],[.44,.12,.02]].map((position,sparkleIndex)=>mesh(new THREE.OctahedronGeometry(.065),materials.cream,position,[1,1,1],g,false));
  const beam=mesh(new THREE.CylinderGeometry(.055,.16,2.3,12,1,true),new THREE.MeshBasicMaterial({color:C.gold,transparent:true,opacity:.28,side:THREE.DoubleSide,depthWrite:false}),[0,.62,0],[1,1,1],g,false);beam.visible=false;
  const labelElement=document.createElement('div');labelElement.className='pickup-label';labelElement.innerHTML=`<strong>${categoryIcon(definition.category)} ${pickupLabelText(definition)}</strong><small>${CATEGORY_LABELS[definition.category]}</small>`;
  const label=new CSS2DObject(labelElement);label.position.set(0,1.9,0);g.add(label);
  scene.add(g);
  const anchor=new THREE.Vector3(definition.home[0],0,definition.home[1]);
  pickups.push({ ...definition, definition, anchor, group:g, visual, outline, pedestal, ring, beam, sparkles, label, labelElement, colour:componentMaterial(definition).color, active:true, respawnAt:0, phase:index*.71 });
}
function createPickups() {
  COMPONENT_DEFINITIONS.forEach(createComponentPickup);
  scene.updateMatrixWorld(true);
  const kioskBounds = new THREE.Box3().setFromObject(stickerKiosk);
  pickups.filter(pickup => pickup.category === 'motifs').forEach(pickup => {
    const pickupBounds = new THREE.Box3().setFromObject(pickup.group);
    console.assert(!pickupBounds.intersectsBox(kioskBounds), `${pickup.type} pickup intersects the kiosk`);
  });
}
function updatePickups(dt,now) {
  if (!gameState.started || gameState.gameOver || gameState.modalOpen || saleGameplayPaused(now)) return;
  const required=detailedMaterialGuidance()?missingTargetComponent():null;
  for (const pickup of pickups) {
    if (!pickup.active && now >= pickup.respawnAt) {
      pickup.active = true;
      pickup.group.visible = true;
    }
    if (!pickup.active) continue;
    pickup.visual.rotation.y += .65*dt;pickup.outline.rotation.y=pickup.visual.rotation.y;
    pickup.visual.position.y=.8+Math.sin(elapsed*Math.PI*3.2+pickup.phase)*.14;pickup.outline.position.y=pickup.visual.position.y;
    pickup.sparkles.forEach((sparkle,index)=>{sparkle.rotation.y+=dt*(2+index);sparkle.position.y+=(Math.sin(elapsed*3+pickup.phase+index)-Math.sin((elapsed-dt)*3+pickup.phase+index))*.035;});
    const isRequired=required?.anchor===pickup.anchor;
    const near=horizontalDistance(player.position,pickup.anchor)<=3.3;
    pickup.labelElement.classList.toggle('visible',near||isRequired);pickup.labelElement.classList.toggle('required',isRequired);
    pickup.outline.visible=isRequired;pickup.beam.visible=isRequired;pickup.ring.material.color.setHex(isNeededPickup(pickup)?C.gold:C.cream);pickup.ring.material.opacity=isNeededPickup(pickup)?.5:.12;
  }
}
function isNeededPickup(pickup) { return Boolean(gameState.activeOrder&&!gameState.hasFinishedDesign&&categoryTotal(pickup.category)===0); }
function canReachPickup(pickup) {
  const anchor=pickup.anchor||pickup.group.position;
  return horizontalDistance(player.position,anchor)<=PICKUP_RADIUS&&clearWalkSegment([player.position.x,player.position.z],[anchor.x,anchor.z]);
}
function collectPickup(pickup, now) {
  if(!pickup.active||totalMaterials()>=gameState.bagCapacity||!canReachPickup(pickup))return false;
  rewardMaterialPickup(pickup, now);
  pickup.active = false;
  pickup.group.visible = false;
  pickup.respawnAt = now + 3000;
  gameState.inventory[pickup.category][pickup.type]++;
  collectionHistory.push(componentId(pickup.category, pickup.type));
  burst(pickup.group.position, 8, pickup.colour, 'sphere', .45);
  popup(`+ ${pickupLabelText(pickup)}`,'pickup');
  pulse('materials-stat');
  playSound('pickup');
  updateHUD();
  return true;
}

function rewardMaterialPickup(pickup, now) {
  const order = gameState.activeOrder;
  if (!order) return;
  order.collectionProgressAt=gameState.activePlayTime;
  const needed=!gameState.hasFinishedDesign&&categoryTotal(pickup.category)===0;
  const identity=pickup.category;
  if (!needed) {
    order.pickupChain = 0;
    order.pickupChainExpiresAt = 0;
    return;
  }
  if (order.rewardedMaterials.includes(identity)) return;
  order.pickupChain = now <= order.pickupChainExpiresAt ? Math.min(4, order.pickupChain + 1) : 1;
  order.rewardedMaterials.push(identity);
  order.pickupChainExpiresAt = now + 7000;
  const style = order.pickupChain * 50;
  order.styleTips += style;
  const label = order.pickupChain === 1 ? 'MATERIAL FOUND!'  : `MATERIAL RUSH ×${order.pickupChain}`;
  popup(`${label} • +${style} HUSTLE`,'sale');
}

function removeTemporaryDrop(index) {
  const [drop] = temporaryDrops.splice(index, 1);
  if (drop) {disposeGeneratedGroup(drop.group);scene.remove(drop.group);}
}

function clearTemporaryDrops() {
  while (temporaryDrops.length) removeTemporaryDrop(temporaryDrops.length - 1);
}

function spawnTemporaryDrop(category, type) {
  const definition = COMPONENT_DEFINITIONS.find(item => item.category === category && item.type === type);
  if (!definition) return;
  const group = new THREE.Group();
  const side = new THREE.Vector3(Math.cos(player.rotation.y), 0, -Math.sin(player.rotation.y)).multiplyScalar(1.3);
  let point=[THREE.MathUtils.clamp(player.position.x+side.x,-PLAYER_BOUNDS,PLAYER_BOUNDS),THREE.MathUtils.clamp(player.position.z+side.z,-PLAYER_BOUNDS,PLAYER_BOUNDS)];
  if(!clearWalkSegment([player.position.x,player.position.z],point))point=[player.position.x,player.position.z];
  group.position.set(point[0], .62, point[1]);
  buildComponentVisual(definition, group);
  const ring = mesh(new THREE.RingGeometry(.38,.5,28), new THREE.MeshBasicMaterial({color:componentMaterial(definition).color,transparent:true,opacity:.38,side:THREE.DoubleSide,depthWrite:false}), [0,-.48,0], [1,1,1], group, false);
  ring.rotation.x = -Math.PI / 2;
  scene.add(group);
  const now = gameNow();
  temporaryDrops.push({ category, type, group, colour:componentMaterial(definition).color, collectibleAt:now + 1250, expiresAt:now + 10000, phase:Math.random() * Math.PI * 2 });
}

function updateTemporaryDrops(now) {
  for (let index = temporaryDrops.length - 1; index >= 0; index--) {
    const drop = temporaryDrops[index];
    if (now >= drop.expiresAt) {
      removeTemporaryDrop(index);
      continue;
    }
    drop.group.rotation.y += .65 / 60;
    drop.group.position.y = .55 + Math.sin(elapsed * Math.PI * 3.2 + drop.phase) * .14;
  }
}
function collectTemporaryDrop(drop) {
  const index=temporaryDrops.indexOf(drop);
  if(index<0||gameNow()<drop.collectibleAt||totalMaterials()>=gameState.bagCapacity||!canReachPickup(drop))return false;
  rewardMaterialPickup(drop,gameNow());gameState.inventory[drop.category][drop.type]++;
  collectionHistory.push(componentId(drop.category,drop.type));burst(drop.group.position,8,drop.colour,'sphere',.45);
  popup(`+1 ${drop.type}`);playSound('pickup');removeTemporaryDrop(index);pulse('materials-stat');updateHUD();return true;
}

function removeHistoryEntry(category, type) {
  const id = componentId(category, type);
  for (let index = collectionHistory.length - 1; index >= 0; index--) {
    if (collectionHistory[index] === id) {
      collectionHistory.splice(index, 1);
      return;
    }
  }
}

function dropInventoryItem(category, type) {
  if (designRevealLocked || gameState.inventory[category]?.[type] < 1) return false;
  gameState.inventory[category][type]--;
  removeHistoryEntry(category, type);
  spawnTemporaryDrop(category, type);
  popup(`DROPPED ${type}`);
  updateHUD();
  if (gameState.modalOpen === 'bag') renderBag();
  return true;
}

function quickDrop() {
  if (simulationSuspended() || !gameState.started || gameState.gameOver || gameState.modalOpen || designRevealLocked) return;
  for (let index = collectionHistory.length - 1; index >= 0; index--) {
    const { category, type } = componentFromId(collectionHistory[index]);
    if (gameState.inventory[category]?.[type] > 0) {
      dropInventoryItem(category, type);
      return;
    }
  }
}

function renderBag() {
  const labels = { garments:'GARMENT', dyes:'DYE', motifs:'PATCH', trims:'TRIM' };
  const rows = [];
  Object.entries(gameState.inventory).forEach(([category, items]) => Object.entries(items).forEach(([type, count]) => {
    if (count > 0) rows.push(`<div class="bag-row"><strong>${type}</strong><span>${labels[category]}</span><b>×${count}</b><button data-drop-category="${category}" data-drop-type="${type}">DROP</button></div>`);
  }));
  document.querySelector('#bag-usage').textContent = `${totalMaterials()} / ${gameState.bagCapacity} SLOTS USED`;
  document.querySelector('#bag-items').innerHTML = rows.join('') || '<p class="bag-empty">YOUR BAG IS EMPTY</p>';
}

function toggleBag() {
  if (gameState.modalOpen === 'bag') return closeModal('bag');
  if (simulationSuspended() || !gameState.started || gameState.gameOver || gameState.modalOpen || designRevealLocked) return;
  openModal('bag');
}

function updateBagFullWarning() {
  const warning = document.querySelector('#bag-full-warning');
  if (!warning) return;
  const nearLandmark = pickups.some(pickup => pickup.active && canReachPickup(pickup));
  const nearTemporary = temporaryDrops.some(drop => canReachPickup(drop));
  warning.classList.toggle('visible', gameState.started && !gameState.gameOver && !gameState.modalOpen && totalMaterials() >= gameState.bagCapacity && (nearLandmark || nearTemporary));
}

// 12. interactions
const dumpsters = [];
let activeInteraction = null;
function updateInteractions(now) {
  activeInteraction = null;
  if (!gameState.started || gameState.gameOver || gameState.modalOpen) return setPrompt(null);
  const options = [];
  for(const counter of CRAFTING_COUNTERS) {
    const distance=horizontalDistance(player.position,counter.point);
    if(gameState.activeOrder&&(!gameState.hasFinishedDesign||gameState.designRejected)&&distance<=INTERACTION_DISTANCE&&clearWalkSegment([player.position.x,player.position.z],[counter.point.x,counter.point.z])) options.push({type:'studio',priority:0,distance,label:gameState.designRejected?'REWORK THE LOOK':'DESIGN CLOTHES'});
  }
  const shopDistance=horizontalDistance(player.position,SHOP_POINT);
  if(shopDistance<=INTERACTION_DISTANCE)options.push({type:'shop',distance:shopDistance,label:'ENTER MY SHOP'});
  if (!gameState.activeOrder) gameState.orderOffers.forEach(offer => {
    const customer = customers.find(item => item.id === offer.customerId);
    if (!customer) return;
    const distance = horizontalDistance(player.position,customer.wrapper.position);
    if (distance <= 1.65 && !customer.resumeAt && !customer.fumingUntil) options.push({ type:'accept-order', priority:0,offer, distance, label:`${customer.name.toUpperCase()} → ${DISTRICTS.find(item=>item.id===offer.destinationId).short}` });
  });
  if (gameState.hasFinishedDesign && gameState.finishedDesign) customers.forEach(customer => {
    if (customer.id !== gameState.activeOrder?.customerId) return;
    const distance = horizontalDistance(player.position,customer.wrapper.position);
    if (distance <= 1.65 && customer.fumingUntil) {
      options.push({ type:'blocked-customer', customer, distance, label:`LEAVE ${customer.name.toUpperCase()} ALONE!` });
    } else if (distance <= 1.65 && customer.atDestination && !customer.resumeAt && !customer.inspectUntil && now >= customer.reactionUntil) {
      options.push({ type:'customer',priority:0, customer, distance, label:`SELL TO ${customer.name.toUpperCase()}` });
    }
  });
  dumpsters.forEach(d => {
    const distance = player.position.distanceTo(d.point);
    if (now >= d.readyAt && distance <= INTERACTION_DISTANCE) options.push({ type: 'dumpster', dumpster: d, distance, label: 'CHECK DUMPSTER' });
  });
  pickups.forEach(pickup=>{if(pickup.active&&canReachPickup(pickup))options.push({type:'pickup',priority:2,pickup,distance:horizontalDistance(player.position,pickup.anchor),label:totalMaterials()>=gameState.bagCapacity?(touchDevice?'BAG FULL · DROP / BAG':'BAG FULL — Q DROP / B BAG'):`TAKE ${pickupLabelText(pickup)}${gameState.activeOrder&&!isNeededPickup(pickup)?' · EXTRA':''}`});});
  temporaryDrops.forEach(drop=>{if(now>=drop.collectibleAt&&canReachPickup(drop))options.push({type:'drop',priority:2,drop,distance:horizontalDistance(player.position,drop.group.position),label:`TAKE DROPPED ${drop.type}`});});
  options.sort((a,b)=>(a.priority??1)-(b.priority??1)||a.distance-b.distance);
  activeInteraction = options[0] || null;
  setPrompt(activeInteraction?.label || null);
}
function handleInteraction() {
  if (simulationSuspended() || !gameState.started || gameState.gameOver || gameState.modalOpen || saleGameplayPaused() || !activeInteraction) return;
  const interaction = activeInteraction;
  if (interaction.type === 'studio') openDesignModal();
  else if(interaction.type==='shop')openModal('shop');
  else if(interaction.type==='accept-order')acceptOrder(interaction.offer);
  else if (interaction.type === 'customer') sellToCustomer(interaction.customer);
  else if (interaction.type === 'dumpster') useDumpster(interaction.dumpster);
  else if (interaction.type === 'pickup') {if(!collectPickup(interaction.pickup,gameNow()))toast(touchDevice?'BAG FULL · DROP OR OPEN BAG':'BAG FULL — Q TO DROP · B TO MANAGE');}
  else if (interaction.type === 'drop') collectTemporaryDrop(interaction.drop);
}

// 13. design system
function openDesignModal() {
  if(!gameState.activeOrder||saleGameplayPaused())return;
  const rework=gameState.designRejected&&gameState.finishedDesign;
  const fields={garments:'selectedGarmentType',dyes:'selectedColour',motifs:'selectedMotif',trims:'selectedTrim'};
  for(const category of MATERIAL_CATEGORIES){const field=fields[category],key=CATEGORY_RECIPE_KEY[category];
    gameState[field]=rework?rework[key]:gameState.inventory[category][gameState[field]]>0?gameState[field]:Object.keys(gameState.inventory[category]).find(type=>gameState.inventory[category][type]>0)||null;
  }
  if(rework){gameState.selectedCut=rework.cutVariant;gameState.selectedAccent=rework.accentColour;}
  renderCustomerCards();designRevealToken++;designRevealLocked=false;pendingDesign=null;craftChallenge=null;
  document.querySelector('#craft-challenge').classList.add('hidden');document.querySelector('#stop-craft').classList.add('hidden');resetStudioReveal();
  document.querySelector('#style-roll').classList.remove('active');document.querySelector('#take-design').classList.add('hidden');document.querySelector('#create-design').classList.remove('hidden');
  document.querySelectorAll('#cancel-design,#create-design,#take-design,#design-modal .practice-modal-skip').forEach(control=>control.disabled=false);
  ensureDraftSeed();syncDesignOptions();setDesignerCategory(gameState.activeOrder.designerCategory||'garment');openModal('design');
}
function ensureDraftSeed(){
  const order=gameState.activeOrder;if(!order)return 0;
  if(gameState.designRejected&&gameState.finishedDesign)order.draftDesignSeed=gameState.finishedDesign.designSeed;
  if(order.draftDesignSeed===null||order.draftDesignSeed===undefined)order.draftDesignSeed=crypto.getRandomValues(new Uint32Array(1))[0];
  return order.draftDesignSeed;
}
function setDesignerCategory(category){
  if(!['garment','colour','motif','trim','cut','accent'].includes(category)||designRevealLocked)return;
  if(gameState.activeOrder)gameState.activeOrder.designerCategory=category;
  document.querySelectorAll('[data-design-tab]').forEach(button=>{const active=button.dataset.designTab===category;button.classList.toggle('active',active);button.setAttribute('aria-selected',active);button.tabIndex=active?0:-1;});
  document.querySelectorAll('[data-design-panel]').forEach(panel=>panel.hidden=panel.dataset.designPanel!==category);
}
function draftMaterialChanges(draft,original=null){return recipeComponents(draft).filter(([category,type])=>!original||original[CATEGORY_RECIPE_KEY[category]]!==type);}
function canCommitDraft(draft=currentDraft()){const original=gameState.designRejected?gameState.finishedDesign:null;return Boolean(gameState.activeOrder&&draft.accentColour!==draft.colour&&recipeComponents(draft).every(([category,type])=>type&&type in gameState.inventory[category])&&draftMaterialChanges(draft,original).every(([category,type])=>gameState.inventory[category][type]>0));}

function calculateMatch(design, request) {
  return ['garmentType','colour','motif','trim'].reduce((score, key) => score + (design[key] === request[key] ? 1 : 0), 0);
}

function calculateSalePrice(fit) { return calculateSaleRewards(gameState.finishedDesign,gameState.activeOrder,gameState.streak).coins; }

function currentDraft() {
  return { garmentType:gameState.selectedGarmentType, colour:gameState.selectedColour, motif:gameState.selectedMotif, trim:gameState.selectedTrim, cutVariant:gameState.selectedCut, accentColour:gameState.selectedAccent };
}

function renderCustomerCards() {
  const customer=targetCustomer();document.querySelector('#customer-cards').innerHTML=customer?`<div class="customer-card selected">${customerPortraitMarkup(customer)}<strong>${customer.name.toUpperCase()}</strong>${briefMarkup(customer.id)}</div>`:'';
}

function syncDesignOptions() {
  if(gameState.selectedAccent===gameState.selectedColour)gameState.selectedAccent=Object.keys(SWATCHES).find(colour=>colour!==gameState.selectedColour);
  document.querySelector('#accent-options').innerHTML=Object.keys(SWATCHES).filter(colour=>colour!==gameState.selectedColour).map(colour=>`<button data-accent="${colour}" class="${gameState.selectedAccent===colour?'selected':''}" aria-pressed="${gameState.selectedAccent===colour}"><i class="fabric-swatch" style="--swatch:${SWATCHES[colour]}"></i><span>${colour}</span></button>`).join('');
  document.querySelectorAll('[data-cut]').forEach(button=>{button.innerHTML=`${garmentThumbnail({...currentDraft(),cutVariant:button.dataset.cut},'cut-'+button.dataset.cut)}<span>${button.dataset.cut}</span>`;button.disabled=false;button.classList.toggle('selected',button.dataset.cut===gameState.selectedCut);button.setAttribute('aria-pressed',button.dataset.cut===gameState.selectedCut);});
  document.querySelector('#designer-style-brief').textContent=customerStyleText(gameState.activeOrder?.customerId);
  const original=gameState.designRejected?gameState.finishedDesign:null;
  for(const [selector,category,key,field]of [['[data-garment]','garments','garment','selectedGarmentType'],['[data-colour]','dyes','colour','selectedColour'],['[data-motif]','motifs','motif','selectedMotif'],['[data-trim]','trims','trim','selectedTrim']]){
    document.querySelectorAll(selector).forEach(button=>{const type=button.dataset[key],count=gameState.inventory[category][type],retained=original?.[CATEGORY_RECIPE_KEY[category]]===type;
      const visual=category==='garments'?garmentThumbnail({...currentDraft(),garmentType:type},'garment-'+type):category==='dyes'?`<i class="fabric-swatch" style="--swatch:${SWATCHES[type]}"></i>`:category==='motifs'?`<svg viewBox="-1 -1 2 2" class="motif-option" aria-hidden="true"><path d="${svgMotifPath(type)}"/>${type==='FLOWER'?'<circle r=".19" fill="#FFFDFB" stroke="none"/>':''}</svg>`:trimThumbnail(type);
      button.innerHTML=`${visual}<span>${type}</span><small class="owned-count">${retained?'IN LOOK':`×${count}`}</small>`;
      button.disabled=count===0&&!retained;button.title=retained?'Keep this component free':count?`${count} owned`:supplierHint(category,type);button.classList.toggle('selected',type===gameState[field]);button.setAttribute('aria-pressed',type===gameState[field]);
    });
  }
  const missing=MATERIAL_CATEGORIES.filter(category=>!currentDraft()[CATEGORY_RECIPE_KEY[category]]);
  document.querySelector('#design-supply-status').textContent=missing.length?`NEED ${missing.map(c=>CATEGORY_LABELS[c]).join(' · ')}`:original?'Keep components free; only replacements use supplies.':'Use one owned garment, dye, motif and trim.';
  document.querySelector('#design-supply-status').dataset.missing=String(missing.length>0);
  document.querySelector('#create-design').disabled=!canCommitDraft();updateFashionPreview();
  const draft=currentDraft();
  document.querySelectorAll('[data-design-tab]').forEach(button=>{const key={garment:'garmentType',colour:'colour',motif:'motif',trim:'trim',cut:'cutVariant',accent:'accentColour'}[button.dataset.designTab];button.classList.toggle('chosen',Boolean(draft[key]));});
}

function copyDesignComposition(design){return Object.fromEntries(['fashionTraits','traitReasons','paletteMoods','styleMatches','paletteMatches','touchMatches'].filter(key=>design[key]!==undefined).map(key=>[key,JSON.parse(JSON.stringify(design[key]))]));}

const CUTS = ['CLASSIC','PUFFY','LAYERED','ASYMMETRIC'];
const RARITY_BONUS = Object.freeze({ EVERYDAY:0, CUTE:5, FABULOUS:12, LEGENDARY:30 });
const RARITY_SCORE_BONUS = Object.freeze({ EVERYDAY:0, CUTE:100, FABULOUS:300, LEGENDARY:800 });
const RARITY_TIME_BONUS = Object.freeze({ EVERYDAY:0, CUTE:0, FABULOUS:0, LEGENDARY:0 });
const RARITY_ADJECTIVE = Object.freeze({ EVERYDAY:'SWEET', CUTE:'ADORABLE', FABULOUS:'FABULOUS', LEGENDARY:'LEGENDARY' });
const SWATCHES = { LAVENDER:'#9A7BFF', MINT:'#75E5C1', PEACH:'#FF9877', SKY:'#70CFFF' };
let pendingDesign = null;
let designRevealLocked = false;
let designRevealToken = 0;
let craftChallenge=null;

function seededUnit(seed, salt = 0) {
  let value = (seed + Math.imul(salt + 1, 0x6D2B79F5)) >>> 0;
  value = Math.imul(value ^ value >>> 15, value | 1);
  value ^= value + Math.imul(value ^ value >>> 7, value | 61);
  return ((value ^ value >>> 14) >>> 0) / 4294967296;
}
function createSeededDesign(draft, seed) {
  const accents = Object.keys(SWATCHES).filter(colour => colour !== draft.colour);
  const accentColour = accents.includes(draft.accentColour)?draft.accentColour:accents[Math.floor(seededUnit(seed, 1) * accents.length)];
  const cutVariant = CUTS.includes(draft.cutVariant)?draft.cutVariant:CUTS[seed % 4];
  return { ...draft, designSeed:seed, cutVariant, accentColour };
}
function rarityForRoll(roll){return roll<.5?'EVERYDAY':roll<.8?'CUTE':roll<.95?'FABULOUS':'LEGENDARY';}
function rarityQualityRoll(design) { const stitchBoost=design.craftBonus===250?.12:design.craftBonus===100?.03:0;return THREE.MathUtils.clamp(seededUnit(design.designSeed,2)+(BRIEF_RARITY_BOOST[design.briefFit]||0)+stitchBoost,0,1-Number.EPSILON); }
function finalizeDesignQuality(design,craftResult) {
  Object.assign(design,{craftRating:craftResult.rating,craftBonus:craftResult.bonus});
  design.rarity=rarityForRoll(rarityQualityRoll(design));
  design.legendaryTrait=resolveLegendaryTrait(design);
  design.name=design.legendaryTrait?`${design.legendaryTrait} ${design.colour} ${design.garmentType}`:`${RARITY_ADJECTIVE[design.rarity]} ${design.cutVariant} ${design.colour} ${design.garmentType}`;
  return design;
}
// Plain data is the sole source of garment identity for SVG, carry and Showcase.
const LEGENDARY_TRAITS=Object.freeze({STAR:'CONSTELLATION',HEART:'HEARTBURST',FLOWER:'BLOOM',BOW:'TWIN BOW',BELT:'JEWEL BELT',RUFFLE:'ROYAL RUFFLE'});
function resolveLegendaryTrait(design){return design.rarity==='LEGENDARY'?LEGENDARY_TRAITS[seededUnit(design.designSeed,500)<.5?design.motif:design.trim]:null;}
const MOTIF_ANCHORS=Object.freeze({
  TOP:[[0,.04],[-.20,.22],[.20,-.17],[-.20,-.18],[.20,.22]],
  DRESS:[[0,-.92],[-.20,-.65],[.25,-1.25],[-.33,-1.40],[.32,-.85]],
  SKIRT:[[0,-.13],[-.20,.12],[.22,-.43],[-.30,-.50],[.23,.12]]
});
function deriveGarmentVisualSpec(design){
  const garment=['TOP','DRESS','SKIRT'].includes(design.garmentType)?design.garmentType:'DRESS';
  const cut=CUTS.includes(design.cutVariant)?design.cutVariant:'CLASSIC',seed=design.designSeed>>>0;
  const skirt=garment==='SKIRT',top=garment==='TOP',puffy=cut==='PUFFY',asymmetric=cut==='ASYMMETRIC',layered=cut==='LAYERED';
  const hem=top?-.52:skirt?-.82:-1.78,hemLeft=hem,hemRight=hem+(asymmetric?(top?.16:.28):0),hemWidth=top?.32:puffy?.84:.73;
  const outline=top?[[-.48,.5],[.48,.5],[.52,-.04],[hemWidth,hemRight],[-hemWidth,hemLeft],[-.52,-.04]]:skirt?[[-.28,.5],[.28,.5],[hemWidth,hemRight],[-hemWidth,hemLeft]]:[[-.46,.5],[.46,.5],[.34,-.42],[hemWidth,hemRight],[-hemWidth,hemLeft],[-.34,-.42]];
  if(layered)for(const point of outline)if(point[1]<=hemRight+.001&&point[1]>=hemLeft-.001)point[1]+=.30;
  const hemAt=x=>hemLeft+(hemRight-hemLeft)*(x+hemWidth)/(hemWidth*2);
  const sleeves=skirt?[]:[{x:-.59,y:.21,rx:puffy?.23:.15,ry:puffy?.27:.20,rotation:-.25},{x:.59,y:asymmetric?.08:.21,rx:puffy?.23:.15,ry:asymmetric?.31:puffy?.27:.20,rotation:.25}];
  const layer=layered?{top:hem+.45,bottomLeft:hem-.04,bottomRight:hemRight-.04,width:hemWidth+.035,topWidth:hemWidth*.72}:null;
  const layout=['STATEMENT','TRIO','SPRINKLE'][Math.floor(seededUnit(seed,501)*3)],count={STATEMENT:1,TRIO:3,SPRINKLE:5}[layout];
  const anchors=MOTIF_ANCHORS[garment],baseSize=top?.19:.23;
  const instances=anchors.slice(0,count).map(([x,y],i)=>({x:x+(layout==='SPRINKLE'?(seededUnit(seed,510+i)-.5)*.035:0),y:y+(layout==='SPRINKLE'?(seededUnit(seed,520+i)-.5)*.035:0),size:layout==='STATEMENT'?baseSize*1.65:layout==='TRIO'?baseSize*.73:baseSize*.49}));
  const ornamentCandidates=top?[[-.29,.35],[.29,.35],[0,-.34],[-.27,-.35],[.27,-.35]]:skirt?[[-.19,.31],[.19,.31],[-.46,-.63],[.46,-.63],[0,-.58]]:[[-.22,.33],[.22,.33],[-.48,-1.47],[.45,-1.39],[0,-1.48]];
  const ornaments=ornamentCandidates.map(([x,y],i)=>({x:x+(seededUnit(seed,540+i)-.5)*.035,y:y+(seededUnit(seed,550+i)-.5)*.035,size:.025+seededUnit(seed,560+i)*.012,kind:['dot','star','dash'][Math.floor(seededUnit(seed,570+i)*3)]})).filter(mark=>instances.every(m=>Math.hypot(mark.x-m.x,mark.y-m.y)>m.size+mark.size+.055)).slice(0,2);
  // Only finalized rarity can affect presentation. Drafts never consult quality roll.
  const rarity=['EVERYDAY','CUTE','FABULOUS','LEGENDARY'].includes(design.rarity)?design.rarity:'PENDING';
  const legendaryTrait=rarity==='LEGENDARY'&&Object.values(LEGENDARY_TRAITS).includes(design.legendaryTrait)?design.legendaryTrait:null;
  const motif={type:design.motif||null,treatment:legendaryTrait==='CONSTELLATION'?'gold':legendaryTrait==='HEARTBURST'?'premium':legendaryTrait==='BLOOM'?'bloom':'cream',layout,instances:design.motif?instances:[],enhancement:[]};
  if(['CONSTELLATION','HEARTBURST','BLOOM'].includes(legendaryTrait)){
    const hero=instances[0],size=baseSize*(legendaryTrait==='BLOOM'?1.20:1.85);
    motif.enhancement=[{...hero,size,hero:true},...[[ -.28,.16],[.30,.12],[-.23,-.24],[.24,-.27]].map(([x,y],i)=>({x:hero.x+x,y:hero.y+y,size:baseSize*(.42+seededUnit(seed,590+i)*.16),hero:false}))];
  }
  const trimY=skirt?.42:design.trim==='BELT'?(top?-.27:-.45):.35;
  const ruffleAnchors=Array.from({length:top?5:7},(_,i)=>{const x=-hemWidth+hemWidth*2*i/(top?4:6);return {x,y:hemAt(x)};});
  return {palette:{main:SWATCHES[design.colour]||'#D9D3E3',accent:SWATCHES[design.accentColour]||'#F4EBDC',motif:'#FFF3C4'},garment,cut,
    silhouette:{outline,sleeves,hemLeft,hemRight,hemWidth,layer,depth:.18,originY:skirt?230:140},
    motif,trim:{type:design.trim||null,y:trimY,width:top?.62:.64,ruffleAnchors,tiers:legendaryTrait==='ROYAL RUFFLE'?2:1,twin:legendaryTrait==='TWIN BOW',jewel:legendaryTrait==='JEWEL BELT'},
    ornaments,material:{roughness:rarity==='LEGENDARY'?.36:rarity==='FABULOUS'?.48:.86,metalness:rarity==='LEGENDARY'?.12:0,satin:rarity==='FABULOUS'||rarity==='LEGENDARY'},
    rarity,legendaryTrait};
}
function flowerContour(){return Array.from({length:64},(_,i)=>{const a=Math.PI/2-i*Math.PI*2/64,r=.84+.16*Math.cos(i*Math.PI*2/64*6);return [Math.cos(a)*r,Math.sin(a)*r];});}
function motifPath(type){
  if(type==='HEART')return 'M0 .85 C-1.5 -.12 -.95 -1.2 0 -.5 C.95 -1.2 1.5 -.12 0 .85Z';
  if(type==='FLOWER'){const pts=flowerContour();return pts.map(([x,y],i)=>`${i?'L':'M'}${x.toFixed(4)} ${(-y).toFixed(4)}`).join(' ')+'Z';}
  const points=Array.from({length:type==='FLOWER'?16:10},(_,i)=>{const a=-Math.PI/2+i*Math.PI*2/(type==='FLOWER'?16:10),r=i%2?(type==='FLOWER'?.57:.43):1;return `${i?'L':'M'}${(Math.cos(a)*r).toFixed(4)} ${(Math.sin(a)*r).toFixed(4)}`;});
  return points.join(' ')+'Z';
}
function svgPolygon(points){return points.map(([x,y],i)=>`${i?'L':'M'}${x*100} ${-y*100}`).join(' ')+'Z';}
// SVG presentation geometry stays separate from the lightweight Three.js outline.
// All coordinates are local to the existing garment origin (100 SVG units per unit).
function garmentSvgGeometry(spec){
  const s=spec.silhouette,top=spec.garment==='TOP',skirt=spec.garment==='SKIRT';
  const puffy=spec.cut==='PUFFY',layered=spec.cut==='LAYERED',asymmetric=spec.cut==='ASYMMETRIC';
  const width=top?(spec.cut==='CLASSIC'?35:39):s.hemWidth*100,waist=skirt?-42:top?27:43;
  const hemCurve=top&&spec.cut==='CLASSIC'?2.5:6;
  const left=-s.hemLeft*100,right=-s.hemRight*100;
  const lift=layered?(top?12:22):0;
  const hemY=(x,raised=0)=>left+(right-left)*(x+width)/(2*width)+hemCurve*(1-(x/width)**2)-raised;
  const hem=(raised=0)=>`M${-width} ${hemY(-width,raised)} Q0 ${(left+right)/2+hemCurve*2-raised} ${width} ${hemY(width,raised)}`;
  const hemBack=(raised=0)=>`Q0 ${(left+right)/2+hemCurve*2-raised} ${-width} ${hemY(-width,raised)}`;
  const cuff=asymmetric?8:-6;
  // The sleeves and bodice share one outer contour, avoiding overlapping oval seams.
  const shoulderRight=puffy
    ?`C29 -55 43 -54 52 -47 C66 -46 77 -25 73 -11 Q70 ${cuff+9} 57 ${cuff+6} Q49 ${cuff+7} 43 ${cuff} L39 -16`
    :`C29 -55 40 -54 49 -46 Q59 -36 68 ${cuff-8} Q62 ${cuff+1} 50 ${cuff+3} L39 -17`;
  const shoulderLeft=puffy
    ?'L-43 -6 Q-49 1 -57 0 Q-70 3 -73 -11 C-77 -25 -66 -46 -52 -47 C-43 -54 -29 -55 -17 -49'
    :'L-50 -3 Q-62 -5 -68 -14 Q-59 -36 -49 -46 C-40 -54 -29 -55 -17 -49';
  // Two tangent-connected sections soften the hip before the lower flare.
  const sideStart=skirt?-50:waist;
  const hipY=sideStart+(Math.min(left,right)-lift-sideStart)*.34;
  const hipWidth=32+(width-32)*.24;
  const sideRight=`C32 ${sideStart+12} ${hipWidth-4} ${hipY-12} ${hipWidth} ${hipY} C${hipWidth+4} ${hipY+12} ${width-5} ${right-lift-18} ${width} ${right-lift}`;
  const sideLeft=`C${-width+5} ${left-lift-18} ${-hipWidth-4} ${hipY+12} ${-hipWidth} ${hipY} C${-hipWidth+4} ${hipY-12} -32 ${sideStart+12} -32 ${sideStart}`;
  const body=skirt
    ?`M-32 -50 Q0 -54 32 -50 ${sideRight} ${hemBack(lift)} ${sideLeft}Z`
    :`M17 -49 ${shoulderRight} C36 1 31 ${waist-13} 32 ${waist} ${top?`C33 ${waist+9} ${width} ${right-lift-8} ${width} ${right-lift}`:sideRight} ${hemBack(lift)} ${top?`C${-width} ${left-lift-8} -33 ${waist+9} -32 ${waist}`:sideLeft} C-31 ${waist-13} -36 1 -39 -17 ${shoulderLeft} Q0 -27 17 -49Z`;
  const underlayer=layered?`M${-width+10} ${left-32} Q0 ${(left+right)/2-24} ${width-10} ${right-32} L${width} ${right} ${hemBack()}Z`:'';
  const bandY=skirt?-46:waist;
  const band=`M-33 ${bandY-5} Q0 ${bandY+1} 33 ${bandY-5} L33 ${bandY+5} Q0 ${bandY+11} -33 ${bandY+5}Z`;
  const foldStart=waist+(Math.min(left,right)-lift-waist)*.38;
  const folds=top?[]:[-.52,.02,.52].map((f,i)=>{
    const x=width*f,y=hemY(x,lift)-12,start=foldStart+[8,20,0][i];
    return `M${x*.66} ${start} C${x*.70+2} ${start+12} ${x*.91-2} ${y-17} ${x} ${y}`;
  });
  return {body,underlayer,hem,hemY,width,waist,band,bandY,lift,folds,foldStart,cuff};
}
function garmentPaths(design){
  const spec=deriveGarmentVisualSpec(design),g=garmentSvgGeometry(spec);
  return {main:g.body,extra:g.underlayer,hemY:spec.silhouette.originY+g.hemY(0)};
}
// Rounded contours are SVG-only; the carried Three.js shapes retain their contract.
function svgMotifPath(type){
  if(type==='HEART')return 'M0 -.43 C-.25 -.79 -.79 -.79 -.88 -.34 C-.99 .12 -.36 .63 -.09 .82 Q0 .91 .09 .82 C.36 .63 .99 .12 .88 -.34 C.79 -.79 .25 -.79 0 -.43Z';
  if(type==='FLOWER'){
    const point=(angle,r)=>`${Math.cos(angle)*r} ${Math.sin(angle)*r}`;
    let path=`M${point(-Math.PI/2-Math.PI/6,.58)}`;
    for(let i=0;i<6;i++){
      const a=-Math.PI/2+i*Math.PI/3;
      path+=` C${point(a-.28,1.12)} ${point(a+.28,1.12)} ${point(a+Math.PI/6,.58)}`;
    }
    return path+'Z';
  }
  const points=Array.from({length:10},(_,i)=>{const a=-Math.PI/2+i*Math.PI/5,r=i%2?.46:1;return [Math.cos(a)*r,Math.sin(a)*r];});
  const mix=(a,b,t)=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
  return points.map((p,i)=>{
    const before=mix(p,points[(i+9)%10],.16),after=mix(p,points[(i+1)%10],.16);
    return `${i?'L':'M'}${before.join(' ')} Q${p.join(' ')} ${after.join(' ')}`;
  }).join(' ')+'Z';
}
function svgBow(x,y,scale=1,premium=false){
  return `<g transform="translate(${x*100} ${-y*100}) scale(${scale})" class="bow-treatment"><path d="M-4 2 C-15 -9 -29 -15 -31 -7 C-34 2 -28 14 -21 11 Q-12 9 -4 5Z M4 2 C15 -9 29 -15 31 -7 C34 2 28 14 21 11 Q12 9 4 5Z"/><path d="M-5 6 Q-9 18 -16 25 Q-11 24 -8 22 L-3 27 Q1 17 2 8 M5 6 Q9 18 16 25 Q11 24 8 22 L3 27 Q-1 17 -2 8"/><path d="M-24 -3 Q-14 0 -6 4 M24 -3 Q14 0 6 4 M-5 11l-3 8 M5 11l3 8" fill="none" stroke-opacity=".22"/><path d="M-27 -6 Q-20 -7 -13 -2 M13 -2 Q20 -7 27 -6" fill="none" stroke="#FFFFFF" stroke-opacity=".35" stroke-width="1.4"/><rect x="-5" y="-2" width="10" height="12" rx="4" fill="${premium?'#E8C36D':'#FFF3C4'}"/><path d="M-2 1Q0 0 2 1" fill="none" stroke="#FFF9E9" stroke-opacity=".8" stroke-width="1.5"/></g>`;
}
function trimSpecMarkup(spec,geometry=garmentSvgGeometry(spec)){
  const t=spec.trim,g=geometry;if(!t.type)return '';
  if(t.type==='BOW')return svgBow(0,t.y,t.twin?.72:.68,t.twin)+(t.twin?svgBow(.23,t.y-.27,.40,true):'');
  if(t.type==='BELT'){
    const y=g.bandY;
    return `<path d="${g.band}" ${t.jewel?'fill="#DDBB72"':''}/><path d="M-28 ${y-2}Q0 ${y+3} 28 ${y-2}" fill="none" stroke="#FFFFFF" stroke-opacity=".3" stroke-width="1"/>${t.jewel?`<g transform="translate(0 ${y+3})"><path d="M0 -10Q1 -10 2 -8L9 0Q10 1 8 3L1 11Q0 12 -1 11L-8 3Q-10 1 -9 0L-2 -8Q-1 -10 0 -10Z" fill="#E8C36D" stroke="#A98B53"/><path d="M0 -7L6 1 0 9-6 1Z" fill="${spec.palette.accent}" stroke="none"/><path d="M0 -7L6 1H0Z" fill="#FFFFFF" fill-opacity=".38" stroke="none"/><path d="M0 1H6L0 9Z" fill="#514264" fill-opacity=".22" stroke="none"/><path d="M-3 -1L0 -5" fill="none" stroke="#FFF9E9" stroke-width="1.4"/></g>`:`<rect x="-7" y="${y-3}" width="14" height="12" rx="3.5" fill="none" stroke="#F6DB91" stroke-width="2.5"/><path d="M-4 ${y-2}H2" stroke="#FFF9E9" stroke-width="1"/>`}`;
  }
  // Draw the lower tier first, keeping each shallow scalloped edge visible.
  return Array.from({length:t.tiers},(_,index)=>t.tiers-1-index).map(tier=>{
    const count=spec.garment==='TOP'?7:9,step=g.width*2/count;
    const y=x=>g.hemY(x)-3+tier*6;
    let path=`M${-g.width} ${y(-g.width)-4}`,seam=path,gathers='';
    for(let i=1;i<=count;i++){
      const x=-g.width+i*step,segment=` Q${x-step/2} ${y(x-step/2)-4} ${x} ${y(x)-4}`;
      path+=segment;seam+=segment;
      gathers+=`M${x-step/2} ${y(x-step/2)-2}l-.8 3 `;
    }
    path+=` L${g.width} ${y(g.width)+1}`;
    for(let i=count;i>0;i--){const x=-g.width+(i-1)*step;path+=` Q${x+step/2} ${y(x+step/2)+8} ${x} ${y(x)+1}`;}
    return `<path d="${path}Z" fill="${tier?spec.palette.motif:spec.palette.accent}"/><path d="${gathers}" fill="none" stroke-opacity=".18" stroke-width=".9"/>${t.tiers>1?`<path d="${seam}" fill="none" stroke="#C4A263" stroke-width="1"/>`:''}`;
  }).join('');
}
function svgMotifPlacement(spec,g){
  const enhanced=spec.motif.enhancement.length>0,top=spec.garment==='TOP',skirt=spec.garment==='SKIRT';
  const source=enhanced?spec.motif.enhancement:spec.motif.instances;
  if(!source.length)return [];
  const items=source.map(m=>({...m,x:m.x*100,y:-m.y*100,size:m.size*100*(top?.76:!enhanced&&spec.motif.layout==='STATEMENT'?.82:1)}));
  if(!top&&!enhanced&&spec.motif.layout==='STATEMENT')items[0].y+=6;
  // Separate supporting Legendary marks before fitting the entire cluster uniformly.
  if(enhanced){
    const hero=items[0];
    for(const m of items.slice(1)){
      const dx=m.x-hero.x,dy=m.y-hero.y,distance=Math.hypot(dx,dy)||1;
      const spacing=Math.max(1,(hero.size+m.size+5)/distance);
      m.x=hero.x+dx*spacing;m.y=hero.y+dy*spacing;
    }
  }
  const bowBottom=-spec.trim.y*100+(spec.trim.twin?40:23);
  const minY=top?(spec.trim.type==='BOW'?bowBottom+5:-27):skirt?Math.max(-30,spec.trim.type==='BOW'?bowBottom+5:-30):g.waist+23;
  const maxY=top&&spec.trim.type==='BELT'?g.bandY-9:Math.min(g.hemY(-g.width),g.hemY(g.width))-g.lift-(spec.trim.type==='RUFFLE'?14:10);
  const halfWidth=top?28:skirt?39:43;
  const bounds={left:Math.min(...items.map(m=>m.x-m.size-3)),right:Math.max(...items.map(m=>m.x+m.size+3)),top:Math.min(...items.map(m=>m.y-m.size-3)),bottom:Math.max(...items.map(m=>m.y+m.size+3))};
  const cx=(bounds.left+bounds.right)/2,cy=(bounds.top+bounds.bottom)/2;
  const scale=Math.min(1,halfWidth*2/(bounds.right-bounds.left),Math.max(8,maxY-minY)/(bounds.bottom-bounds.top));
  const rx=(bounds.right-bounds.left)*scale/2,ry=(bounds.bottom-bounds.top)*scale/2;
  const x=Math.max(-halfWidth+rx,Math.min(halfWidth-rx,cx)),y=Math.max(minY+ry,Math.min(maxY-ry,cy));
  return items.map(m=>({...m,x:x+(m.x-cx)*scale,y:y+(m.y-cy)*scale,size:m.size*scale}));
}
function svgMotifMarkup(spec,m,scope){
  const type={CONSTELLATION:'STAR',HEARTBURST:'HEART',BLOOM:'FLOWER'}[spec.legendaryTrait]||spec.motif.type;
  const path=svgMotifPath(type),bloom=spec.legendaryTrait==='BLOOM'&&m.hero;
  const fill=spec.legendaryTrait==='CONSTELLATION'?'#F0D07C':spec.palette.motif;
  const outline=spec.legendaryTrait==='CONSTELLATION'?'#AF9059':'#A4957E';
  const detailed=m.size>=13;
  return `<g transform="translate(${m.x} ${m.y}) scale(${m.size})" stroke="${outline}" stroke-width=".04"><path d="${path}" fill="${fill}"/>${detailed?`<path d="${path}" fill="url(#${scope}-applique)" stroke="none"/><path d="${type==='HEART'?'M-.65 -.27Q-.62 -.52 -.40 -.52':type==='FLOWER'?'M-.24 -.78Q0 -.97 .24 -.78':'M-.09 -.66L-.20 -.37'}" fill="none" stroke="#FFFFFF" stroke-opacity=".65" stroke-width=".055"/>`:''}${bloom?`<path d="${path}" transform="rotate(30) scale(.62)" fill="${spec.palette.accent}" stroke="#BD9F68" stroke-width=".045"/>`:''}${type==='FLOWER'?`<circle r="${bloom?.22:.19}" fill="${spec.legendaryTrait==='BLOOM'?'#E6BC61':spec.palette.main}" stroke="none"/>${bloom&&detailed?'<path d="M-.10 -.06Q0 -.15 .10 -.06" fill="none" stroke="#FFF3C4" stroke-width=".045"/>':''}`:''}</g>`;
}
function svgLegendaryOverlay(spec,motifs){
  if(!motifs.length)return '';
  const hero=motifs[0],trait=spec.legendaryTrait;
  if(trait==='CONSTELLATION'){
    const links=motifs.slice(1).map(m=>`M${hero.x} ${hero.y}L${m.x} ${m.y}`).join(' ');
    const glints=motifs.slice(1,3).map(m=>{const x=m.x+m.size+2,y=m.y-m.size*.6;return `M${x-2} ${y}h4 M${x} ${y-2}v4`;}).join(' ');
    return `<g fill="none" stroke="#C4A263"><path d="${links}" stroke-width=".9" stroke-opacity=".4"/><path d="${glints}" stroke-width="1" stroke-opacity=".7"/></g>`;
  }
  if(trait==='HEARTBURST'){
    const rays=[-.85,-.15,1.7,2.5].map(a=>{const r=hero.size+2;return `M${hero.x+Math.cos(a)*r} ${hero.y+Math.sin(a)*r}l${Math.cos(a)*3} ${Math.sin(a)*3}`;}).join(' ');
    return `<path d="${rays}" fill="none" stroke="#C4A263" stroke-opacity=".55" stroke-width="1.1"/>`;
  }
  return '';
}
let garmentSvgInstance=0;
function garmentSpecMarkup(spec,id='live'){
  const s=spec.silhouette,g=garmentSvgGeometry(spec);
  // The namespace is instance-specific; geometry and decoration remain seed-deterministic.
  const scope=`garment-${String(id).replace(/[^a-zA-Z0-9_-]/g,'-')}-${++garmentSvgInstance}`;
  const motifs=svgMotifPlacement(spec,g);
  const motifMarkup=motifs.map(m=>svgMotifMarkup(spec,m,scope)).join('');
  const ornaments=spec.ornaments.filter(m=>motifs.every(mark=>Math.hypot(m.x*100-mark.x,-m.y*100-mark.y)>mark.size+m.size*100+5));
  return `<defs><linearGradient id="${scope}-fabric" x1="0" x2="1" y1="0" y2="1"><stop stop-color="${spec.palette.main}"/><stop offset="1" stop-color="${spec.palette.main}"/></linearGradient><linearGradient id="${scope}-light" x1="0" x2="1" y1="0" y2=".65"><stop stop-color="#FFFFFF" stop-opacity=".25"/><stop offset=".48" stop-color="#FFFFFF" stop-opacity="${spec.material.satin?.19:.04}"/><stop offset="1" stop-color="#514264" stop-opacity=".13"/></linearGradient><linearGradient id="${scope}-applique" x1="0" y1="0" x2="0" y2="1"><stop stop-color="#FFFFFF" stop-opacity=".16"/><stop offset=".65" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="1" stop-color="#66516F" stop-opacity=".13"/></linearGradient><linearGradient id="${scope}-fold" gradientUnits="userSpaceOnUse" x1="0" y1="${g.foldStart}" x2="0" y2="${g.hemY(0,g.lift)-10}"><stop stop-color="#514264" stop-opacity="0"/><stop offset=".45" stop-color="#514264" stop-opacity=".13"/><stop offset="1" stop-color="#514264" stop-opacity=".09"/></linearGradient></defs>
  <g class="garment-art rarity-${spec.rarity.toLowerCase()}" data-layout="${spec.motif.layout}" data-trait="${spec.legendaryTrait||''}" transform="translate(150 ${s.originY})" stroke="#796B87" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">
  <defs><clipPath id="${scope}-clip" clipPathUnits="userSpaceOnUse"><path d="${g.body}"/></clipPath></defs>
  ${g.underlayer?`<path d="${g.underlayer}" fill="${spec.palette.accent}"/><path d="${g.hem()}" fill="none" stroke="#FFFFFF" stroke-opacity=".4"/>`:''}
  <path class="garment-main" d="${g.body}" fill="url(#${scope}-fabric)" style="fill:url(#${scope}-fabric)"/>
  <g clip-path="url(#${scope}-clip)">
    <path d="${g.body}" fill="url(#${scope}-light)" stroke="none"/>
    <g fill="none" stroke="url(#${scope}-fold)" stroke-width="1.1">${g.folds.map(d=>`<path d="${d}"/>`).join('')}</g>
    ${spec.garment==='TOP'&&spec.cut==='CLASSIC'?'':`<path d="${g.hem(g.lift+4)}" fill="none" stroke="#FFFFFF" stroke-opacity=".24" stroke-width="1"/>`}
    ${spec.garment==='SKIRT'?`<path d="${g.band}" fill="${spec.palette.main}"/><path d="M-28 -45 Q0 -40 28 -45" fill="none" stroke="#FFFFFF" stroke-opacity=".35"/>`:`<path d="M-17 -47 Q0 -25 17 -47" fill="none" stroke="${spec.palette.accent}" stroke-width="3"/><path d="M-39 -33 Q-34 -24 -39 -17 M39 -33 Q34 -24 39 -17" fill="none" stroke-opacity=".22" stroke-width="1.2"/>`}
    ${spec.cut==='PUFFY'&&spec.garment!=='SKIRT'?`<path d="M-70 -9 Q-58 -1 -46 -9 M46 ${g.cuff-3} Q58 ${g.cuff+5} 70 ${g.cuff-3}" fill="none" stroke="${spec.palette.accent}" stroke-width="4"/><path d="M-65 -15l-1 6 M-56 -12v5 M56 ${g.cuff-8}v5 M65 ${g.cuff-11}l1 6" stroke-opacity=".3" fill="none"/>`:''}
    <g class="seed-ornaments" fill="${spec.palette.accent}" stroke="none" opacity=".65">${ornaments.map(m=>m.kind==='dot'?`<circle cx="${m.x*100}" cy="${-m.y*100}" r="${m.size*75}"/>`:`<path d="${m.kind==='star'?svgMotifPath('STAR'):'M-1 -.2H1V.2H-1Z'}" transform="translate(${m.x*100} ${-m.y*100}) scale(${m.size*85})"/>`).join('')}</g>
    ${svgLegendaryOverlay(spec,motifs)}<g class="motif-instances">${motifMarkup}</g>
  </g>
  <g class="trim-treatment" fill="${spec.palette.accent}" stroke-width="1.4" ${spec.trim.type==='BELT'?`clip-path="url(#${scope}-clip)"`:''}>${trimSpecMarkup(spec,g)}</g></g>`;
}
function garmentThumbnail(design,id='thumbnail'){const spec=deriveGarmentVisualSpec({...design,designSeed:gameState.activeOrder?.draftDesignSeed||0,rarity:null,legendaryTrait:null});return `<svg class="garment-option" viewBox="45 65 210 280" aria-hidden="true">${garmentSpecMarkup(spec,id)}</svg>`;}
function trimThumbnail(type){const spec=deriveGarmentVisualSpec({garmentType:'TOP',trim:type,colour:'LAVENDER',accentColour:'PEACH',designSeed:0});return `<svg class="trim-option" viewBox="${type==='BOW'?'-40 -65 80 80':type==='BELT'?'-40 15 80 40':'-48 40 96 40'}" aria-hidden="true"><g fill="${spec.palette.accent}" stroke="#625374" stroke-width="2">${trimSpecMarkup(spec)}</g></svg>`;}
function updateFashionPreview(forcedDesign=null){
  const draft=currentDraft(),design=forcedDesign||{...draft,designSeed:ensureDraftSeed(),rarity:null,legendaryTrait:null};
  const spec=deriveGarmentVisualSpec(design),layer=document.querySelector('#garment-layer');layer.innerHTML=garmentSpecMarkup(spec);
  layer.dataset.seed=design.designSeed;layer.dataset.rarity=spec.rarity;layer.dataset.layout=spec.motif.layout;
  const composition=deriveLookComposition(design),look=document.querySelector('#match-preview'),previous=new Set([...look.querySelectorAll('[data-look-trait]')].map(el=>el.dataset.lookTrait));
  look.innerHTML=`<strong>YOUR LOOK</strong><div>${composition.fashionTraits.map(trait=>`<span data-look-trait="${trait}" class="${previous.has(trait)?'':'trait-arrival'}">${trait}</span>`).join(' · ')||'<span class="look-empty">Try a combination</span>'}</div><div>${composition.paletteMoods.join(' · ')||'<span class="look-empty">Choose two colours</span>'}</div>`;
  if(!forcedDesign&&!matchMedia('(prefers-reduced-motion: reduce)').matches)layer.animate([{opacity:.7,transform:'translateY(2px)'},{opacity:1,transform:'translateY(0)'}],{duration:160});
}
function makeMotifShape(pattern){
  const shape=new THREE.Shape();
  if(pattern==='HEART'){shape.moveTo(0,-.85);shape.bezierCurveTo(-1.5,.12,-.95,1.2,0,.5);shape.bezierCurveTo(.95,1.2,1.5,.12,0,-.85);}
  else if(pattern==='FLOWER'){flowerContour().forEach(([x,y],i)=>i?shape.lineTo(x,y):shape.moveTo(x,y));}
  else{const count=pattern==='FLOWER'?16:10;for(let i=0;i<count;i++){const a=Math.PI/2-i*Math.PI*2/count,r=i%2?(pattern==='FLOWER'?.57:.43):1;const x=Math.cos(a)*r,y=Math.sin(a)*r;if(i)shape.lineTo(x,y);else shape.moveTo(x,y);}}
  shape.closePath();if(pattern==='FLOWER'){const centre=new THREE.Path();centre.absarc(0,0,.24,0,Math.PI*2,true);shape.holes.push(centre);}return shape;
}
function createPatternMesh(pattern){return new THREE.Mesh(new THREE.ShapeGeometry(makeMotifShape(pattern)),materials.yellow);}
function buildGarmentModel(design,parent,includeSparkles=true){
  const spec=deriveGarmentVisualSpec(design),s=spec.silhouette,t=spec.trim,unit=.60;
  const main=mat(spec.palette.main,{roughness:spec.material.roughness,metalness:spec.material.metalness});
  const accent=mat(spec.palette.accent,{roughness:spec.material.roughness});
  const cream=mat(spec.palette.motif,{roughness:spec.material.roughness});
  const premium=spec.legendaryTrait?mat(0xEEC765,{metalness:.65,roughness:.3,emissive:0xD9A64A,emissiveIntensity:.035}):cream;
  parent.userData.ownedGarmentMaterials=[main,accent,cream,premium];
  parent.userData.garmentIdentity={seed:design.designSeed,layout:spec.motif.layout,motifCount:spec.motif.instances.length,legendaryTrait:spec.legendaryTrait};
  const add=(geometry,material,x,y,z,sx=1,sy=sx,sz=sx)=>mesh(geometry,material,[x*unit,y*unit,z],[sx,sy,sz],parent);
  function body(points,material,depth){const shape=new THREE.Shape();points.forEach(([x,y],i)=>i?shape.lineTo(x*unit,y*unit):shape.moveTo(x*unit,y*unit));shape.closePath();const g=new THREE.ExtrudeGeometry(shape,{depth,bevelEnabled:true,bevelSegments:1,steps:1,bevelSize:.015,bevelThickness:.015,curveSegments:8});g.translate(0,0,-depth/2);return add(g,material,0,0,0);}
  if(s.layer)body([[-s.layer.topWidth,s.layer.top],[s.layer.topWidth,s.layer.top],[s.layer.width,s.layer.bottomRight],[-s.layer.width,s.layer.bottomLeft]],accent,s.depth+.012);
  body(s.outline,main,s.depth);
  for(const sleeve of s.sleeves)add(sphere,main,sleeve.x,sleeve.y,0,sleeve.rx*unit,sleeve.ry*unit,.12).rotation.z=-sleeve.rotation;
  const motifs=spec.motif.enhancement.length?spec.motif.enhancement:spec.motif.instances;
  if(motifs.length){const geometry=new THREE.ShapeGeometry(makeMotifShape(spec.motif.type));for(const m of motifs){const motif=add(geometry,spec.motif.treatment==='gold'?premium:cream,m.x,m.y,.13,m.size*unit);motif.userData.garmentMotif=true;if(spec.legendaryTrait==='BLOOM')add(sphere,premium,m.x,m.y,.142,m.size*unit*.23,m.size*unit*.23,.025);}}
  for(const ornament of spec.ornaments){const geometry=ornament.kind==='star'?new THREE.ShapeGeometry(makeMotifShape('STAR')):ornament.kind==='dash'?box:sphere;const mark=add(geometry,accent,ornament.x,ornament.y,.145,ornament.size*unit,ornament.kind==='dash'?.009:ornament.size*unit,.012);mark.userData.garmentOrnament=true;}
  function bow(x,y,size,knotMaterial){
    const shape=new THREE.Shape();shape.moveTo(0,0);shape.bezierCurveTo(-.34*size,.25*size,-.35*size,-.20*size,-.06*size,-.07*size);shape.lineTo(-.17*size,-.34*size);shape.lineTo(-.05*size,-.29*size);shape.lineTo(0,-.11*size);shape.lineTo(.05*size,-.29*size);shape.lineTo(.17*size,-.34*size);shape.lineTo(.06*size,-.07*size);shape.bezierCurveTo(.35*size,-.20*size,.34*size,.25*size,0,0);shape.closePath();
    const geometry=new THREE.ExtrudeGeometry(shape,{depth:.035,bevelEnabled:true,bevelSize:.012,bevelThickness:.015,bevelSegments:1,curveSegments:6});
    add(geometry,accent,x,y,.13,unit,unit,1);add(sphere,knotMaterial,x,y,.19,.045*size,.055*size,.045);
  }
  if(t.type==='BOW'){bow(0,t.y,t.twin?1.2:1,premium);if(t.twin)bow(.27,t.y-.39,.62,premium);}
  else if(t.type==='BELT'){add(box,t.jewel?premium:accent,0,t.y,.14,t.width*unit,.07,.035);add(box,premium,0,t.y,.17,.105,.09,.018);add(box,accent,0,t.y,.185,.055,.045,.012);if(t.jewel)add(new THREE.OctahedronGeometry(.055),mat(spec.palette.accent,{metalness:.3,roughness:.2,emissive:spec.palette.accent,emissiveIntensity:.13}),0,t.y,.23);}
  else if(t.type==='RUFFLE')for(let tier=0;tier<t.tiers;tier++){
    const shape=new THREE.Shape(),anchors=t.ruffleAnchors;shape.moveTo(anchors[0].x-.12,anchors[0].y+.045-tier*.13);
    for(const a of anchors)shape.lineTo(a.x+.12,a.y+.045-tier*.13);
    for(const a of [...anchors].reverse())shape.quadraticCurveTo(a.x,a.y-.20-tier*.13,a.x-.12,a.y-tier*.13);
    shape.closePath();add(new THREE.ExtrudeGeometry(shape,{depth:.035,bevelEnabled:false,curveSegments:4}),tier?cream:accent,0,0,.12,unit,unit,1);
  }
  // Carry sparkles are optional presentation, never the defining Legendary trait.
  if(includeSparkles&&spec.rarity==='FABULOUS'){
    const orbit=new THREE.Group();orbit.userData.sparkleOrbit=true;parent.add(orbit);
    for(let i=0;i<2;i++)mesh(new THREE.OctahedronGeometry(.035),materials.cream,[i?-.5:.5,.12,0],[1,1,1],orbit,false);
  }
  return parent;
}

function clearCarriedDesign() {
  if(!carriedDesign)return;
  disposeGeneratedGroup(carriedDesign);
  player.remove(carriedDesign);carriedDesign=null;
}
function spawnCarriedDesign() {
  clearCarriedDesign();
  carriedDesign = new THREE.Group();
  buildGarmentModel(gameState.finishedDesign,carriedDesign,true);
  carriedDesign.position.set(.62, 1.25, -.45);
  carriedDesign.scale.set(.72, .72, .72);
  if(gameState.finishedDesign.rarity==='LEGENDARY'){
    const badgeElement=document.createElement('div'); badgeElement.className='carried-rarity-badge'; badgeElement.textContent='LEGENDARY';
    const badge=new CSS2DObject(badgeElement); badge.position.set(0,.88,0); carriedDesign.add(badge);
  }
  player.add(carriedDesign);
}
function scheduleDesignReveal(token, delay, callback) {
  setGameTimeout(() => { if (token === designRevealToken && designRevealLocked) callback(); }, delay);
}
function resetStudioReveal() {
  const modal=document.querySelector('#design-modal'), preview=document.querySelector('#fashion-preview'), reveal=document.querySelector('#studio-reveal');
  modal.classList.remove('reveal-everyday','reveal-cute','reveal-fabulous','reveal-legendary','legendary-hold');
  preview.classList.remove('creating','rolling','anticipating','reveal-everyday','reveal-cute','reveal-fabulous','reveal-legendary');
  if(reveal)reveal.replaceChildren();
  document.querySelectorAll('.component-fly').forEach(element=>element.remove());
}
function animateDesignComponents(draft) {
  const previewRect=document.querySelector('#fashion-preview').getBoundingClientRect();
  const targetX=previewRect.left+previewRect.width/2, targetY=previewRect.top+previewRect.height*.48;
  const definitions=[
    [`[data-garment="${draft.garmentType}"]`,draft.garmentType],
    [`[data-colour="${draft.colour}"]`,'●'],
    [`[data-motif="${draft.motif}"]`,requestSymbol(draft.motif)],
    [`[data-trim="${draft.trim}"]`,draft.trim]
  ];
  definitions.forEach(([selector,label],index)=>{
    const source=document.querySelector(selector), rect=source?.getBoundingClientRect(); if(!rect||!rect.width||!rect.height)return;
    const fly=document.createElement('span'); fly.className='component-fly'; fly.textContent=label;
    fly.style.left=`${rect.left+rect.width/2}px`; fly.style.top=`${rect.top+rect.height/2}px`; document.body.appendChild(fly);
    fly.animate([
      {transform:'translate(-50%,-50%) scale(1)',opacity:1},
      {transform:`translate(${targetX-(rect.left+rect.width/2)}px,${targetY-(rect.top+rect.height/2)}px) scale(.12)`,opacity:0}
    ],{duration:280,delay:index*18,easing:'cubic-bezier(.2,.75,.25,1)',fill:'forwards'}).finished.finally(()=>fly.remove());
  });
}
function addStudioParticles(count, kind, seed) {
  const reveal=document.querySelector('#studio-reveal');
  for(let index=0;index<count;index++){
    const particle=document.createElement('i'); particle.className=`studio-particle ${kind}`;
    const angle=seededUnit(seed,100+index)*Math.PI*2, radius=46+seededUnit(seed,200+index)*105;
    particle.style.setProperty('--particle-x',`${Math.cos(angle)*radius}px`);
    particle.style.setProperty('--particle-y',`${Math.sin(angle)*radius}px`);
    particle.style.setProperty('--particle-delay',`${seededUnit(seed,300+index)*.12}s`);
    particle.style.setProperty('--particle-rotate',`${Math.round(seededUnit(seed,400+index)*360)}deg`);
    reveal.appendChild(particle);
  }
}
function revealStudioRarity(design) {
  const rarity=design.rarity, lower=rarity.toLowerCase(), modal=document.querySelector('#design-modal');
  const reveal=document.querySelector('#studio-reveal'), preview=document.querySelector('#fashion-preview');
  modal.classList.remove('legendary-hold'); modal.classList.add(`reveal-${lower}`); preview.classList.remove('rolling','anticipating'); preview.classList.add(`reveal-${lower}`);
  document.querySelector('#roll-rarity').textContent=rarity;
  updateFashionPreview(design);
  const headline=rarity==='EVERYDAY'?'EVERYDAY':`${rarity}!`;
  const subheadline=rarity==='LEGENDARY'?`<span class="legendary-trait-name">${design.legendaryTrait}</span>`:'';
  const time=RARITY_TIME_BONUS[rarity];
  const details=`<span class="reveal-details">${design.cutVariant} CUT · ${design.accentColour} ACCENT<br>${design.motif} MOTIF · ${design.trim} FINISH</span>`;
  const bonuses=rarity==='FABULOUS'||rarity==='LEGENDARY'?`<em>+${RARITY_BONUS[rarity]} COINS ON SALE<br>+${RARITY_SCORE_BONUS[rarity]} SCORE${time?` · +${time} SEC`:''}</em>`:'';
  reveal.innerHTML=`${rarity==='LEGENDARY'?'<div class="legendary-ring"></div>':''}<strong>${headline}</strong>${subheadline}<b>${design.name}</b>${details}${bonuses}`;
  addStudioParticles({EVERYDAY:8,CUTE:14,FABULOUS:24,LEGENDARY:40}[rarity],rarity==='LEGENDARY'?'confetti':'sparkle',design.designSeed);
  document.querySelector('#style-roll-status').textContent=design.name;
  document.querySelector('#design-result').textContent=`${rarity} • +${RARITY_BONUS[rarity]} COINS • +${RARITY_SCORE_BONUS[rarity]} SCORE${time?` • +${time} SEC`:''}`;
  playSound(`reveal${rarity[0]}${rarity.slice(1).toLowerCase()}`);
}
function finishDesignCraft(draft,design,token) {
  if(token!==designRevealToken||design.materialsCommitted)return;
  const original=gameState.designRejected?gameState.finishedDesign:null,changes=draftMaterialChanges(draft,original);
  if(changes.some(([category,type])=>gameState.inventory[category][type]<1))return;
  for(const [category,type]of changes){gameState.inventory[category][type]--;removeHistoryEntry(category,type);}
  if(original)for(const [category]of changes){const type=original[CATEGORY_RECIPE_KEY[category]];if(totalMaterials()<gameState.bagCapacity){gameState.inventory[category][type]++;collectionHistory.push(componentId(category,type));}else spawnTemporaryDrop(category,type);}
  design.materialsCommitted=true;gameState.hasFinishedDesign=true;gameState.designRejected=false;gameState.finishedDesign=design;revealStudioRarity(design);
  scheduleDesignReveal(token,110,()=>{document.querySelector('#take-design').classList.remove('hidden');document.querySelector('#take-design').disabled=false;document.querySelector('#take-design').focus();designRevealLocked=false;updateHUD();});
}
function craftResultForProgress(progress) {
  const distance=Math.abs(progress-.5);
  return distance<=.05+1e-9?{rating:'PERFECT STITCH',bonus:250}:distance<=.2+1e-9?{rating:'GOOD STITCH',bonus:100}:{rating:'MISS STITCH',bonus:0};
}
function createDesign() {
  const draft=currentDraft();
  if(designRevealLocked||(gameState.hasFinishedDesign&&!gameState.designRejected)||!canCommitDraft(draft))return;
  const seed=ensureDraftSeed();
  pendingDesign=createSeededDesign(draft,seed);designRevealLocked=true;
  Object.assign(pendingDesign,calculateBriefFit(pendingDesign,gameState.activeOrder.customerId),{briefCustomerId:gameState.activeOrder.customerId});
  document.querySelector('#roll-rarity').textContent='—';
  const token=++designRevealToken;
  document.querySelectorAll('#design-modal button:not(.practice-modal-skip)').forEach(control=>control.disabled=true);

  resetStudioReveal();
  document.querySelector('#create-design').classList.add('hidden');
  document.querySelector('#craft-challenge').classList.remove('hidden');
  document.querySelector('#craft-status').textContent='HIT THE GREEN CENTRE';
  const stop=document.querySelector('#stop-craft');stop.classList.remove('hidden');stop.disabled=false;stop.focus();
  craftChallenge={start:gameNow(),token,draft,design:pendingDesign};
  document.querySelector('#craft-marker').style.left='0%';
  playSound('pickup');
}
function updateCraftChallenge(now) {
  if(!craftChallenge||simulationSuspended())return;
  const progress=THREE.MathUtils.clamp((now-craftChallenge.start)/2000,0,1);
  document.querySelector('#craft-marker').style.left=`${progress*100}%`;
  if(progress>=1)stopCraftChallenge();
}
function stopCraftChallenge() {
  if(!craftChallenge||simulationSuspended())return;
  const challenge=craftChallenge,now=gameNow();
  if(now-challenge.start<150)return;
  craftChallenge=null;
  const result=craftResultForProgress(THREE.MathUtils.clamp((now-challenge.start)/2000,0,1));
  finalizeDesignQuality(challenge.design,result);
  document.querySelector('#craft-status').textContent=result.bonus===250?'PERFECT STITCH! RARE CHANCE UP':result.rating;
  const track=document.querySelector('.craft-track');track.dataset.feedback=result.bonus===250?'perfect':result.bonus===100?'good':'miss';
  if(result.bonus===250)addStudioParticles(16,'sparkle',challenge.design.designSeed);playSound(result.bonus===250?'perfect':result.bonus===100?'upgrade':'fail');
  document.querySelector('#stop-craft').classList.add('hidden');
  document.querySelector('#style-roll').classList.add('active');
  document.querySelector('#roll-cut').textContent=challenge.design.cutVariant;
  document.querySelector('#roll-accent').textContent=challenge.design.accentColour;
  animateDesignComponents(challenge.draft);
  finishDesignCraft(challenge.draft,challenge.design,challenge.token);
}

function takeDesign() {
  if(!gameState.finishedDesign)return;
  spawnCarriedDesign(); designRevealLocked=false; designRevealToken++;
  document.querySelector('#take-design').classList.add('hidden');
  document.querySelector('#create-design').classList.remove('hidden');
  document.querySelectorAll('#design-modal button').forEach(control=>control.disabled=false);
  document.querySelector('#style-roll').classList.remove('active');
  pendingDesign=null; resetStudioReveal(); closeModal('design'); updateHUD();
}

// 14. selling/economy
let offerInProgress = null;
let salePauseUntil = 0;
let saleCelebrationCustomer = null;
let hudCountup = null;
let cameraCelebration = null;
function saleGameplayPaused(now=gameNow()){return Boolean(offerInProgress)||gameState.modalOpen==='results'||now<salePauseUntil;}
function showCustomerSpeech(customer, text, duration = 1500) {
  if (customer.speechLabel) customer.wrapper.remove(customer.speechLabel);
  clearGameTimeout(customer.speechTimer);
  const element=document.createElement('div'); element.className='customer-speech'; element.textContent=text;
  const speech=new CSS2DObject(element); speech.position.set(0,2.45,0); customer.wrapper.add(speech); customer.speechLabel=speech;
  customer.speechTimer=setGameTimeout(()=>{customer.wrapper.remove(speech); if(customer.speechLabel===speech)customer.speechLabel=null;},duration);
}
function comboMultiplier() { return [1,1,1.25,1.5,1.75,2][Math.min(5,gameState.streak)]; }
function orderTimeRemaining(order = gameState.activeOrder) { return order ? Math.max(0,order.deadlineSeconds-order.elapsedTravelTime) : 0; }
function speedGradeForOrder(order) {
  const remaining=orderTimeRemaining(order),fraction=remaining/order.deadlineSeconds;
  if(order.orderLate||remaining<=0)return {name:'LATE',multiplier:.6,timeBonus:-5,coinBonus:0};
  if(fraction>.4)return {name:'EXPRESS',multiplier:1.5,timeBonus:10,coinBonus:15};
  if(fraction>.1)return {name:'ON TIME',multiplier:1.15,timeBonus:5,coinBonus:5};
  return {name:'CUTTING IT CLOSE',multiplier:.9,timeBonus:0,coinBonus:0};
}
function calculateSaleRewards(design,order,streak=gameState.streak) {
  const fit=design.briefFit,speed=speedGradeForOrder(order),accepted=fit>=1;
  const nextStreak=speed.name==='LATE'?0:streak+1,combo=[1,1,1.25,1.5,1.75,2][Math.min(5,nextStreak)];
  if(!accepted)return {accepted:false,speed,score:0,coins:0,time:0,nextStreak:0,combo:1};
  const touchScore=design.personalTouches*100,touchCoins=design.personalTouches*5,rarity=design.rarity;
  const ordinary=([0,35,50,60][fit]+RARITY_BONUS[rarity]+SHOP_BONUS[gameState.shopLevel]+speed.coinBonus)*(gameState.rareNextSale?2:1);
  const coins=Math.max(0,Math.round(ordinary*(speed.name==='LATE'?.5:1)))+touchCoins;
  const runway=fit===3&&speed.name==='EXPRESS'&&rarity==='LEGENDARY';
  const score=Math.round((BRIEF_REWARDS[fit]+order.styleTips)*speed.multiplier*order.difficultyMultiplier*combo)+touchScore+RARITY_SCORE_BONUS[rarity]+(design.craftBonus||0)+(runway?500:0);
  return {accepted:true,speed,score,coins,time:speed.timeBonus,nextStreak,combo,runway,touchScore,touchCoins};
}
function saleReaction(fit,grade){return fit===0?'angry':grade==='LATE'?'angry':grade==='CUTTING IT CLOSE'||fit===1?'idle':'celebrate';}
function availableUpgrades(){return [{type:'bag',cost:BAG_COST[gameState.bagLevel+1],available:gameState.bagLevel<3},{type:'shop',cost:SHOP_COST[gameState.shopLevel+1],available:gameState.shopLevel<3},{type:'worker',cost:100,available:!gameState.workerOwned}].filter(item=>item.available).sort((a,b)=>a.cost-b.cost);}
function upgradeState(){const next=availableUpgrades()[0];return {next,affordable:Boolean(next&&gameState.coins>=next.cost)};}
function continueSale(visitShop=false){
  if(simulationSuspended()||gameState.gameOver||gameState.modalOpen!=='results')return;
  if(visitShop&&!upgradeState().affordable)return;
  hudCountup=null;salePauseUntil=0;gameState.modalOpen=null;document.querySelector('#results-modal').classList.remove('open');clearInput();
  if(gameState.practice){finishPractice();return;}
  gameState.shopObjective=visitShop;updateControlVisibility();syncPlatformGameplay();updateHUD();
  if(!visitShop)generateOrderOffers();
}
function showSaleResults(result) {
  const stack=document.querySelector('#sale-results'),profile=CUSTOMER_STYLE_PROFILES[result.customerId],design=result.design;
  stack.className=`sale-results verdict-${design.briefFit}${result.runway?' runway-results':''}`;
  stack.innerHTML=`<strong class="sale-hero">${result.customerName.toUpperCase()} · ${briefVerdict(design.briefFit)}</strong><div class="brief-explanation"><p>${profile.styleTag} ${design.styleMatches.length?'✓':'○'} ${design.styleMatches.slice(0,3).join(' · ')||'No combination for this trait'}</p><p>${profile.paletteTag} ${design.paletteMatches.length?'✓':'○'} ${design.paletteMatches.slice(0,1).join(' · ')||'No colour pair for this mood'}</p>${personalTouchText(result.customerId)?`<p>PERSONAL TOUCH ${design.touchMatches.length?'✓':'○'} ${design.touchMatches.join(' · ')||'None'}<small>+${result.touchScore} SCORE · +${result.touchCoins} COINS</small></p>`:''}</div><div class="result-line" data-step="0"><span>CRAFT</span><b>${design.craftRating}</b></div><div class="result-line" data-step="1"><span>DELIVERY</span><b>${result.speed.name==='LATE'?'LATE DELIVERY':result.speed.name}</b></div><div class="result-line" data-step="2"><span>RARITY</span><b>${design.rarity}</b></div><div class="result-line" data-step="3"><span>HUSTLE</span><b>+${result.styleTips}</b></div><div class="result-line" data-step="4"><span>COMBO</span><b>×${result.combo.toFixed(2)}</b></div>${result.runway?'<p>RUNWAY MOMENT · +500 SCORE</p>':''}<div class="result-totals" data-step="5"><b data-total="time">0 SEC</b><b data-total="score">0 SCORE</b><b data-total="coins">0 COINS</b></div>`;
  hudCountup={start:gameNow(),duration:550,from:result.previous,to:result.totals,display:{...result.previous},gains:{time:result.timeAwarded,score:result.score,coins:result.coins},stack};
  document.querySelector('#visit-shop').classList.toggle('hidden',!upgradeState().affordable||gameState.practice);openModal('results');
  document.querySelector('#next-job').focus();
}
function updateSaleCountup(now) {
  if(!hudCountup)return;
  const elapsed=now-hudCountup.start;
  hudCountup.stack.querySelectorAll('[data-step]').forEach(element=>{
    const step=Number(element.dataset.step), threshold=[0,50,100,150,200,250,300,345][step];
    element.classList.toggle('visible',elapsed>=threshold);
  });
  const progress=THREE.MathUtils.smoothstep(THREE.MathUtils.clamp((elapsed-345)/205,0,1),0,1);
  hudCountup.display.coins=Math.round(THREE.MathUtils.lerp(hudCountup.from.coins,hudCountup.to.coins,progress));
  hudCountup.display.score=Math.round(THREE.MathUtils.lerp(hudCountup.from.score,hudCountup.to.score,progress));
  hudCountup.display.time=THREE.MathUtils.lerp(hudCountup.from.time,hudCountup.to.time,progress);
  const timeValue=Math.round(hudCountup.gains.time*progress), scoreValue=Math.round(hudCountup.gains.score*progress), coinValue=Math.round(hudCountup.gains.coins*progress);
  hudCountup.stack.querySelector('[data-total="time"]').textContent=`${timeValue>=0?'+':''}${timeValue} SEC`;
  hudCountup.stack.querySelector('[data-total="score"]').textContent=`+${scoreValue.toLocaleString()} SCORE`;
  hudCountup.stack.querySelector('[data-total="coins"]').textContent=`+${coinValue} COINS`;
  document.querySelector('#coins-value').textContent=hudCountup.display.coins;
  document.querySelector('#score-value').textContent=hudCountup.display.score.toLocaleString();
  document.querySelector('#timer-value').textContent=formatTime(hudCountup.display.time);
  if(elapsed>=hudCountup.duration){hudCountup=null;updateHUD();}
}
function sellToCustomer(customer) {
  if (simulationSuspended() || gameState.gameOver || !gameState.started || gameState.timeRemaining<=0 || !gameState.hasFinishedDesign || !gameState.finishedDesign || !customer.atDestination || customer.resumeAt || customer.fumingUntil || offerInProgress) return;
  offerInProgress=customer; customer.inspectUntil=gameNow()+550; customer.sellingPaused=true; setPrompt(null);
  const generation=runGeneration;
  setGameTimeout(()=>{if(generation===runGeneration)resolveCustomerOffer(customer);},550);
}
function resolveCustomerOffer(customer) {
  if(simulationSuspended()||gameState.gameOver||!gameState.started||offerInProgress!==customer||!gameState.finishedDesign||gameState.activeOrder?.customerId!==customer.id)return;
  const order=gameState.activeOrder,design=gameState.finishedDesign,now=gameNow();
  Object.assign(design,calculateBriefFit(design,customer.id));const rewards=calculateSaleRewards(design,order);
  customer.inspectUntil=0;offerInProgress=null;
  if(rewards.accepted){
    const previous={coins:gameState.coins,time:gameState.timeRemaining,score:gameState.score};
    gameState.coins+=rewards.coins;gameState.score+=rewards.score;gameState.timeRemaining=THREE.MathUtils.clamp(gameState.timeRemaining+rewards.time,0,MAX_ARCADE_TIME);
    gameState.streak=rewards.nextStreak;gameState.bestCombo=Math.max(gameState.bestCombo,gameState.streak);gameState.stats.sales++;
    if(design.briefFit===3)gameState.stats.perfectMatches++;if(design.rarity==='LEGENDARY')gameState.stats.legendaryDesigns++;
    recordShowcaseSale(design);gameState.previousCustomerId=customer.id;gameState.previousDestinationId=order.destinationId;gameState.activeOrder=null;gameState.nextOffersAt=0;
    gameState.hasFinishedDesign=false;gameState.designRejected=false;gameState.finishedDesign=null;gameState.rareNextSale=false;clearCarriedDesign();
    salePauseUntil=now+550;saleCelebrationCustomer=customer;customer.sellingPaused=true;customer.reactionUntil=now+1500;customer.resumeAt=now+2200;
    const reaction=saleReaction(design.briefFit,rewards.speed.name),action=customer.animation.actions[reaction];
    if(action&&reaction!=='idle'){action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;}customer.animation.play(reaction);
    customer.annoyance=rewards.speed.name==='LATE'?Math.min(4,customer.annoyance+1):Math.max(0,customer.annoyance-1);
    const deliveryCopy=rewards.speed.name==='LATE'?'You’re late!':rewards.speed.name==='CUTTING IT CLOSE'?'Just in time…':rewards.speed.name==='EXPRESS'?'So quick!':'';
    showCustomerSpeech(customer,`${briefVerdict(design.briefFit)} ${deliveryCopy}${reaction==='celebrate'&&customer.line?' '+customer.line:''}`,2200);
    const point=customer.wrapper.position.clone().add(new THREE.Vector3(0,.7,0)),ecstatic=design.briefFit===3&&rewards.speed.name==='EXPRESS';
    if(reaction==='celebrate'){burst(point,ecstatic?24:10,C.coral,'heart',.95);if(ecstatic)createPerfectRing(customer.wrapper.position);}else burst(point,3,reaction==='angry'?C.urgent:C.cream,'sphere',.55);
    if(reaction!=='angry'&&design.rarity==='LEGENDARY')burst(point,16,C.gold,'confetti',1);
    triggerTownEvents(order.destinationId);if(rewards.runway)cameraCelebration={customer,start:now,duration:700};
    playSound(reaction==='angry'?'fail':ecstatic?'perfect':'sell');pulse('coin-stat');
    if(gameState.practice)gameState.practiceFinishing=true;
    showSaleResults({...rewards,customerId:customer.id,customerName:customer.name,design,styleTips:order.styleTips,previous,totals:{coins:gameState.coins,time:gameState.timeRemaining,score:gameState.score},timeAwarded:gameState.timeRemaining-previous.time});
  }else{
    gameState.timeRemaining=Math.max(0,gameState.timeRemaining-6);gameState.streak=0;gameState.designRejected=true;
    if(!customer.countedAnnoyed){customer.countedAnnoyed=true;gameState.stats.customersAnnoyed++;}
    customer.annoyance=Math.min(4,customer.annoyance+2);customer.annoyanceVisibleUntil=now+1900;customer.reactionUntil=now+1100;customer.sellingPaused=false;customer.rejectionCount++;
    const action=customer.animation.actions.angry;if(action){action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;}customer.animation.play('angry');
    showCustomerSpeech(customer,`NOT MY VIBE. I’m after ${customerStyleText(customer.id)}.`);popup('NOT MY VIBE · −6 SEC','fail');playSound('fail');
    toast('Take this look to any counter. Keep pieces free; exchange only what you change.');
    if(customer.annoyance>=3){customer.fumingUntil=now+6000;customer.chaseUntil=now+4000;customer.goAwayShown=false;}
    showRejectedVerdict(design,customer);
  }
  customers.forEach(refreshCustomerBubble);updateHUD();updateInteractions(now);if(!gameState.practice&&gameState.timeRemaining<=0)endRun();
}
function showRejectedVerdict(design,customer){
  const profile=CUSTOMER_STYLE_PROFILES[customer.id];toast(`NOT MY VIBE · ${profile.styleTag}: ${design.styleMatches.join(' · ')||'no combination for this trait'} · ${profile.paletteTag}: ${design.paletteMatches.slice(0,1).join(' · ')||'no colour pair for this mood'} · REWORK AT ANY COUNTER`);
}

// 15. shop and upgrades
const componentCategoryLabels={garments:'GARMENT',dyes:'DYE',motifs:'PATCH',trims:'TRIM'};
function orderRecipeText(recipe){return `${recipe.garmentType} · ${recipe.colour} · ${requestSymbol(recipe.motif)} ${recipe.motif} · ${recipe.trim}`;}
function orderCardsMarkup() {
  return gameState.orderOffers.map(offer=>{const customer=customers.find(item=>item.id===offer.customerId),destination=DISTRICTS.find(item=>item.id===offer.destinationId);return `<article class="shop-order-card ${offer.difficultyClass}"><small class="order-tier">${offer.difficulty} · SCORE ×${offer.difficultyMultiplier.toFixed(1)}</small>${customerPortraitMarkup(customer)}<strong>${customer.name}</strong>${briefMarkup(customer.id)}<b>${destination.name}</b><span>${readyCategoryCount()} categories ready · ~${offer.estimatedTravelSeconds}s walking</span><strong class="order-deadline">${offer.deadlineSeconds}s DEADLINE</strong><button class="primary" data-accept-order="${offer.customerId}">CHOOSE ${offer.difficulty}</button></article>`;}).join('')||'<p class="orders-pending">Choose NEXT JOB after your sale.</p>';
}
function renderOrderBoard(){document.querySelector('#order-board-items').innerHTML=orderCardsMarkup();}
function openOrderBoard(){
  if(!gameState.started||gameState.gameOver||gameState.activeOrder||gameState.modalOpen||saleGameplayPaused())return;
  renderOrderBoard();openModal('orders');
}
function choicesPauseClocks(){return ['design','orders','bag','shop','results','details'].includes(gameState.modalOpen);}
function renderShopOrders(){
  const container=document.querySelector('#shop-order-items');if(gameState.activeOrder){const customer=targetCustomer(),order=gameState.activeOrder;container.innerHTML=`<article class="shop-order-card active-order"><small>ACTIVE ORDER · ${order.difficulty} · SCORE ×${order.difficultyMultiplier}</small>${customerPortraitMarkup(customer)}<strong>${customer.name}</strong>${briefMarkup(customer.id)}<b>→ ${DISTRICTS.find(item=>item.id===order.destinationId).name}</b><span>${order.deadlineSeconds}s deadline</span></article>`;}else container.innerHTML=orderCardsMarkup();
}
function totalStockroom(){return Object.values(gameState.stockroom).reduce((total,category)=>total+Object.values(category).reduce((sum,count)=>sum+count,0),0);}
function renderStockroom(){
  const rows=[];
  Object.entries(gameState.inventory).forEach(([category,types])=>Object.keys(types).forEach(type=>{
    const bagCount=gameState.inventory[category][type],stockCount=gameState.stockroom[category][type];
    rows.push(`<div class="stockroom-row"><strong>${type} <small>${componentCategoryLabels[category]}</small></strong><span>BAG ×${bagCount}</span><button data-transfer="store" data-category="${category}" data-type="${type}" ${bagCount<1||totalStockroom()>=STOCKROOM_CAPACITY?'disabled':''}>STORE →</button><span>STOCK ×${stockCount}</span><button data-transfer="retrieve" data-category="${category}" data-type="${type}" ${stockCount<1||totalMaterials()>=gameState.bagCapacity?'disabled':''}>← TAKE</button></div>`);
  }));
  document.querySelector('#stockroom-usage').textContent=`${totalStockroom()} / ${STOCKROOM_CAPACITY}`;
  document.querySelector('#stockroom-items').innerHTML=rows.join('');
}
function renderShowcaseItems(){
  document.querySelector('#showcase-items').innerHTML=Array.from({length:3},(_,index)=>{const entry=gameState.showcase[index];if(!entry)return '<article class="showcase-card empty"><strong>EMPTY MANNEQUIN</strong><span>Sell a look to fill this plinth.</span></article>';const design=entry.design;return `<article class="showcase-card"><div class="showcase-icon">${requestSymbol(design.motif)}</div><strong>${design.rarity}</strong><span>${design.name}</span><span>${briefVerdict(entry.briefFit)}</span><span>${design.trim}</span></article>`;}).join('');
}
function renderShop(){
  document.querySelectorAll('[data-shop-tab]').forEach(button=>button.classList.toggle('active',button.dataset.shopTab===gameState.shopTab));
  document.querySelectorAll('.shop-section').forEach(section=>section.classList.toggle('active',section.id===`shop-${gameState.shopTab}`));
  renderShopOrders();renderStockroom();renderShowcaseItems();renderUpgradeCards();
}
function transferStockroom(direction,category,type){
  if(gameState.modalOpen!=='shop'||gameState.gameOver)return;
  if(direction==='store'){
    if(gameState.inventory[category]?.[type]<1||totalStockroom()>=STOCKROOM_CAPACITY)return;
    gameState.inventory[category][type]--;gameState.stockroom[category][type]++;removeHistoryEntry(category,type);
  }else{
    if(gameState.stockroom[category]?.[type]<1||totalMaterials()>=gameState.bagCapacity)return;
    gameState.stockroom[category][type]--;gameState.inventory[category][type]++;collectionHistory.push(componentId(category,type));
  }
  playSound('pickup');updateHUD();renderShop();
}
function recordShowcaseSale(design){
  gameState.showcase.push({design:{...design,...copyDesignComposition(design)},briefFit:design.briefFit,sequence:++gameState.showcaseSequence});
  gameState.showcase.sort((a,b)=>RARITY_RANK[b.design.rarity]-RARITY_RANK[a.design.rarity]||b.briefFit-a.briefFit||b.sequence-a.sequence);gameState.showcase=gameState.showcase.slice(0,3);refreshWorldShowcase();
}

function renderUpgradeCards() {
  const bagMax = gameState.bagLevel >= 3;
  const shopMax = gameState.shopLevel >= 3;
  const cards = [
    { type: 'bag', icon: '◇', title: 'BAG', text: `Bag holds ${gameState.bagCapacity}`, next: bagMax ? 'MAX LEVEL' : `Next: Bag holds ${BAG_CAPACITY[gameState.bagLevel + 1]}`, cost: bagMax ? 0 : BAG_COST[gameState.bagLevel + 1], done: bagMax },
    { type: 'shop', icon: '◆', title: 'SHOP', text: `CUSTOMER SALE BONUS +${SHOP_BONUS[gameState.shopLevel]}`, next: shopMax ? 'MAX LEVEL' : `Next: +${SHOP_BONUS[gameState.shopLevel + 1]} customer sale bonus`, cost: shopMax ? 0 : SHOP_COST[gameState.shopLevel + 1], done: shopMax },
    { type: 'worker', icon: '✦', title: 'ASSISTANT', text: 'Earn 10 coins every 20 seconds', next: gameState.workerOwned ? 'HIRED' : 'A friendly shop assistant', cost: gameState.workerOwned ? 0 : 100, done: gameState.workerOwned }
  ];
  document.querySelector('#upgrade-cards').innerHTML = cards.map(card => `<article class="upgrade-card"><div class="icon">${card.icon}</div><h3>${card.title}</h3><p>${card.text}</p><p class="next">${card.next}</p><button data-upgrade="${card.type}" ${card.done || gameState.coins < card.cost ? 'disabled' : ''}>${card.done ? card.next : `${card.cost} COINS`}</button></article>`).join('');
}
function buyUpgrade(type) {
  let cost = 0, message = '';
  if (type === 'bag' && gameState.bagLevel < 3) { cost = BAG_COST[gameState.bagLevel + 1]; message = 'BAG UPGRADED!'; }
  if (type === 'shop' && gameState.shopLevel < 3) { cost = SHOP_COST[gameState.shopLevel + 1]; message = 'SHOP UPGRADED!'; }
  if (type === 'worker' && !gameState.workerOwned) { cost = 100; message = 'ASSISTANT HIRED!'; }
  if (!cost || gameState.coins < cost) return;
  gameState.coins -= cost;
  if (type === 'bag') { gameState.bagLevel++; gameState.bagCapacity = BAG_CAPACITY[gameState.bagLevel]; pulse('materials-stat'); }
  if (type === 'shop') gameState.shopLevel++;
  if (type === 'worker') hireWorker();
  playSound('upgrade');
  toast(message);
  burst(player.position.clone().add(new THREE.Vector3(0, 1, 0)), 8, new THREE.Color(C.lavender), 'spark', .55);
  pulse('coin-stat');
  updateHUD();
  renderUpgradeCards();
}

// 16. worker
let worker = null;
let workerAnimation = null;
let workerElapsed = 0;
function hireWorker() {
  if (gameState.workerOwned) return;
  gameState.workerOwned = true;
  worker = new THREE.Group();
  worker.position.set(-1.62, 0, -1.78);
  worker.rotation.y = Math.PI;
  shopBuilding.add(worker);
  const wrapper=worker,generation=runGeneration;
  loader.loadAsync('assets/third_party/kenney-mini-characters/Models/GLB%20format/character-male-b.glb').then(gltf => {
    if(generation!==runGeneration||wrapper!==worker){disposeOwnedCharacter(gltf.scene);return;}
    workerAnimation = prepareAnimatedCharacter(gltf, wrapper, 1.59);
    workerAnimation.play('idle');
  }).catch(error => console.error('Assistant model failed to load', error));
  workerElapsed=0;
}
function updateAssistant(dt) {
  if(!gameState.workerOwned||!gameState.started||gameState.gameOver||simulationSuspended()||choicesPauseClocks()||saleGameplayPaused())return;
  workerElapsed+=dt;
  if(workerElapsed>=20){
    workerElapsed-=20;
    gameState.coins += 10;
    updateHUD();
    pulse('coin-stat');
    const notice = document.querySelector('#assistant-popup');
    notice.classList.add('show');
    setGameTimeout(() => notice.classList.remove('show'), 1200);
  }
}

// 17. dumpsters
function createDumpster(x, z, id) {
  const g = groupAt(x, 0, z, id === 'A' ? .15 : -.4);
  mesh(box, materials.darkMint, [0, .65, 0], [1.55, 1.3, 1.05], g);
  const lid = mesh(box, materials.cream, [0, 1.38, -.04], [1.7, .18, 1.14], g);
  lid.rotation.x = -.08;
  mesh(cylinder, materials.ink, [-.58, .12, 0], [.16, .15, .16], g).rotation.z = Math.PI / 2;
  mesh(cylinder, materials.ink, [.58, .12, 0], [.16, .15, .16], g).rotation.z = Math.PI / 2;
  const label = worldLabel('REUSE');
  label.position.set(0, 1.8, 0); g.add(label);
  dumpsters.push({ id, group: g, point: new THREE.Vector3(x, 0, z), readyAt: 0 });
}
function useDumpster(dumpster) {
  const roll = Math.random();
  dumpster.readyAt = gameNow() + 30000;
  if (roll < .35) {
    gameState.coins += 20; popup('LUCKY FIND! +20 COINS'); pulse('coin-stat');
  } else if (roll < .60) {
    gameState.speedBoostUntil = gameState.activePlayTime*1000 + 8000; popup('SPEED BOOST!');
  } else if (roll < .80) {
    if (gameState.rareNextSale) { gameState.coins += 20; popup('LUCKY FIND! +20 COINS'); pulse('coin-stat'); }
    else { gameState.rareNextSale = true; popup('RARE FIND! NEXT CUSTOMER SALE ×2'); }
  } else popup('NOTHING THIS TIME!');
  dumpster.group.rotation.y += .08;
  updateHUD();
  updateInteractions(gameNow());
}

// 18. audio
let audioContext = null;
let masterGain = null;
const musicController = {
  tracks: {
    title: new Audio('./assets/music/title.mp3'),
    gameplay: new Audio('./assets/music/gameplay.ogg'),
    gameover: new Audio('./assets/music/gameover.mp3')
  },
  state: 'title',
  unlocked: false,
  muted: false,
  fadeFrame: 0,
  targetVolume(state = this.state) {
    if (state === 'title') return .30;
    if (state === 'designing') return .12;
    return .25;
  },
  trackFor(state = this.state) { return state === 'designing' ? 'gameplay' : state; },
  unlock() {
    if (this.unlocked) {
      const track=this.tracks[this.trackFor()];if(!this.muted&&track.paused)track.play().catch(()=>{});
      return;
    }
    this.unlocked = true;
    this.setState(this.state, .15);
  },
  setMuted(muted) { this.muted = muted; this.setState(this.state, muted ? 0 : .12); },
  setState(state, duration = .5) {
    this.state = state;
    cancelAnimationFrame(this.fadeFrame);
    const destination = this.trackFor(state);
    const start = performance.now();
    const initial = Object.fromEntries(Object.entries(this.tracks).map(([name, track]) => [name, track.volume]));
    if (this.unlocked && !this.muted) this.tracks[destination].play().catch(() => {});
    const animateFade = now => {
      const progress = duration ? THREE.MathUtils.clamp((now - start) / (duration * 1000), 0, 1) : 1;
      Object.entries(this.tracks).forEach(([name, track]) => {
        const target = !this.muted && name === destination ? this.targetVolume(state) : 0;
        track.volume = initial[name] + (target - initial[name]) * progress;
      });
      if (progress < 1) this.fadeFrame = requestAnimationFrame(animateFade);
      else Object.entries(this.tracks).forEach(([name, track]) => { if ((this.muted || name !== destination) && track.volume === 0) track.pause(); });
    };
    this.fadeFrame = requestAnimationFrame(animateFade);
  }
};
Object.values(musicController.tracks).forEach(track => { track.loop = true; track.preload = 'auto'; });
function initAudio() {
  if (audioContext) return;
  if(!window.AudioContext&&!window.webkitAudioContext)return;
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioContext.createGain();
  masterGain.gain.value = gameState.soundEnabled&&!platform.muteAudio&&!simulationSuspended() ? .105 : 0;
  masterGain.connect(audioContext.destination);
}
function note(frequency, start, duration, type = 'sine', endFrequency = null, peak = .6) {
  if (!audioContext || !gameState.soundEnabled || platform.muteAudio || simulationSuspended()) return;
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(frequency, start);
  if (endFrequency) osc.frequency.exponentialRampToValueAtTime(endFrequency, start + duration);
  gain.gain.setValueAtTime(.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + .012);
  gain.gain.exponentialRampToValueAtTime(.0001, start + duration);
  osc.connect(gain).connect(masterGain);
  osc.start(start); osc.stop(start + duration + .02);
}
function noiseSweep(start, duration, startFrequency, endFrequency, peak = .18) {
  if(!audioContext||!gameState.soundEnabled||platform.muteAudio||simulationSuspended())return;
  const frames=Math.ceil(audioContext.sampleRate*duration), buffer=audioContext.createBuffer(1,frames,audioContext.sampleRate), data=buffer.getChannelData(0);
  for(let index=0;index<frames;index++)data[index]=(Math.random()*2-1)*(1-index/frames*.35);
  const source=audioContext.createBufferSource(), filter=audioContext.createBiquadFilter(), gain=audioContext.createGain();
  source.buffer=buffer; filter.type='bandpass'; filter.Q.value=.8; filter.frequency.setValueAtTime(startFrequency,start); filter.frequency.exponentialRampToValueAtTime(endFrequency,start+duration);
  gain.gain.setValueAtTime(.0001,start); gain.gain.exponentialRampToValueAtTime(peak,start+.025); gain.gain.exponentialRampToValueAtTime(.0001,start+duration);
  source.connect(filter).connect(gain).connect(masterGain); source.start(start); source.stop(start+duration+.02);
}
function playDesignRollAudio() {
  if(!audioContext||!gameState.soundEnabled||platform.muteAudio||simulationSuspended())return;
  const start=audioContext.currentTime;
  [0,.07,.14,.21].forEach((offset,index)=>note(280+index*35,start+offset,.048,'triangle',null,.2));
  const ticks=[[.30,420],[.42,465],[.53,510],[.63,560],[.72,615],[.80,675],[.87,735],[.93,800]];
  ticks.forEach(([offset,frequency])=>note(frequency,start+offset,.05,'triangle',null,.3));
  noiseSweep(start+.96,.18,520,1500,.14);
}
function playSound(type) {
  if (!audioContext || !gameState.soundEnabled || platform.muteAudio || simulationSuspended()) return;
  const t = audioContext.currentTime;
  if(type==='urgent'){note(330,t,.09,'triangle',null,.2);note(440,t+.12,.09,'triangle',null,.2);}
  if (type === 'pickup') note(660, t, .1, 'sine', 900);
  if (type === 'create') { note(523, t, .12, 'triangle'); note(784, t + .08, .13, 'triangle'); }
  if (type === 'sell') [784, 988, 1319].forEach((f, i) => note(f, t + i * .065, .12));
  if (type === 'perfect') [784, 988, 1319, 1568].forEach((f, i) => note(f, t + i * .055, .16, 'triangle'));
  if (type === 'revealEveryday') { note(523,t,.12,'triangle',null,.35); note(659,t+.07,.14,'triangle',null,.35); }
  if (type === 'revealCute') [659,784,988].forEach((f,i)=>note(f,t+i*.055,.14,'triangle',null,.38));
  if (type === 'revealFabulous') [659,880,1047,1319].forEach((f,i)=>note(f,t+i*.045,.16,'triangle',null,.4));
  if (type === 'revealLegendary') { [784,988,1319].forEach(f=>note(f,t,.28,'triangle',null,.32)); note(1760,t+.13,.35,'sine',null,.3); noiseSweep(t,.3,420,1800,.09); }
  if (type === 'legendarySale') { [784,988,1319].forEach(f=>note(f,t,.18,'triangle',null,.24)); note(1760,t+.1,.2,'sine',null,.2); }
  if (type === 'fail') { note(220, t, .16, 'square', 150); note(165, t + .12, .2, 'triangle', 110); }
  if (type === 'upgrade') [523, 659, 784].forEach((f, i) => note(f, t + i * .07, .13, 'triangle'));
}

// 19. HUD/UI updates
let lastObjective = '';
let lastUrgentSecond = -1;
let lastRenderedScore = -1;
function formatTime(seconds) {
  const total=Math.max(0,Math.ceil(seconds)); return `${String(Math.floor(total/60)).padStart(2,'0')}:${String(total%60).padStart(2,'0')}`;
}
function updateTimerDisplay() {
  const card=document.querySelector('#timer-card'), status=document.querySelector('#timer-status'), value=document.querySelector('#timer-value');
  const designing=choicesPauseClocks(), displayTime=hudCountup?.display.time??gameState.timeRemaining; status.textContent=designing?'CHOICES · CLOCK PAUSED':''; value.textContent=formatTime(displayTime);
  if(gameState.practice){status.textContent='PRACTICE';value.textContent=compactMode?'∞':'UNTIMED';}
  else if(!designing)status.textContent='RUN TIME';
  card.setAttribute('aria-label',gameState.practice?'Practice · no time limit':`Run time ${value.textContent}`);
  card.classList.toggle('warning',gameState.timeRemaining<=30&&gameState.timeRemaining>15); card.classList.toggle('urgent',gameState.timeRemaining<=15&&gameState.timeRemaining>5); card.classList.toggle('critical',gameState.timeRemaining<=5);
  const second=Math.ceil(gameState.timeRemaining); if(!gameState.practice&&!choicesPauseClocks()&&!saleGameplayPaused()&&gameState.started&&gameState.timeRemaining<=15&&second!==lastUrgentSecond){card.classList.remove('tick');void card.offsetWidth;card.classList.add('tick');lastUrgentSecond=second;if(second===15||second%5===0)playSound('urgent');}
}
function updateScoreDisplay() {
  const value=hudCountup?.display.score??gameState.score;
  const card=document.querySelector('#score-card');
  document.querySelector('#score-value').textContent=value.toLocaleString();
  if(lastRenderedScore>=0&&value!==lastRenderedScore){card.classList.remove('bump');void card.offsetWidth;card.classList.add('bump');}
  lastRenderedScore=value;
  const multiplier=comboMultiplier(), combo=document.querySelector('#combo-value'); combo.textContent=multiplier>1?`COMBO ×${multiplier.toFixed(2)}`:'';
}
function targetCustomer() { return customers.find(customer => customer.id === gameState.activeOrder?.customerId); }
function missingTargetComponent() {
  const missing=pickups.filter(isNeededPickup), available=missing.filter(item=>item.active);
  const choices=available.length?available:missing;
  if(choices.includes(selectedPickup))return selectedPickup;
  selectedPickup=choices.reduce((nearest,pickup)=>!nearest||walkingLength(player.position,pickup.anchor)<walkingLength(player.position,nearest.anchor)?pickup:nearest,null);
  return selectedPickup;
}
function navigationTarget() {
  if(gameState.shopObjective)return {id:'shop',point:SHOP_POINT,label:'VISIT MY SHOP',kind:'shop',name:'UPGRADES'};
  if(!gameState.activeOrder){
    if(!gameState.practice)return null;
    const customer=customers.find(item=>item.id===gameState.practiceOffer?.customerId);
    return customer?{id:customer.id,point:customer.wrapper.position,label:`MEET ${customer.name.toUpperCase()}`,kind:'customer'}:null;
  }
  if(gameState.hasFinishedDesign&&!gameState.designRejected){
    const customer=targetCustomer();
    if(!customer)return null;
    const ready=customer.atDestination&&!customer.fumingUntil&&!customer.resumeAt&&!customer.inspectUntil&&gameNow()>=customer.reactionUntil;
    return {id:customer.id,point:customer.wrapper.position,label:`${ready?'SELL TO':'FIND'} ${customer.name.toUpperCase()}`,kind:'customer'};
  }
  if(gameState.designRejected&&gameState.finishedDesign){
    const counter=selectedCounter||(selectedCounter=nearestCraftingCounter());
    return {id:counter.id,point:counter.point,label:'REWORK YOUR LOOK',kind:'counter',name:counter.name};
  }
  const missing=MATERIAL_CATEGORIES.some(category=>categoryTotal(category)===0);
  if(missing&&!detailedMaterialGuidance())return null;
  const pickup=missing?missingTargetComponent():null;
  if(pickup){selectedCounter=null;return {id:pickups.indexOf(pickup),point:pickup.anchor,label:`${pickup.active?'TAKE':'WAIT FOR'} ${pickupLabelText(pickup)}`,kind:'pickup',name:pickup.landmark};}
  const counter=selectedCounter||(selectedCounter=nearestCraftingCounter());
  return {id:counter.id,point:counter.point,label:'CRAFT YOUR LOOK',kind:'counter',name:counter.name};
}
function objectiveText() {
  if (gameState.modalOpen === 'design') return 'MAKE YOUR DESIGN';
  if(gameState.shopObjective)return 'VISIT MY SHOP · UPGRADES';
  if (!gameState.activeOrder) return gameState.previousCustomerId ? 'PICK YOUR NEXT FASHION ORDER' : 'PICK YOUR FASHION ORDER';
  const target=navigationTarget();
  return target?.kind==='customer'?target.label:target?.name||`CHOOSE MATERIALS · ${touchDevice?'INTERACT':'E'} TO TAKE · ${touchDevice?'GUIDE':'G FOR GUIDE'}`;
}
function updateCollectionHUD() {
  const components=document.querySelector('#target-components');
  const collecting=Boolean(gameState.started&&!gameState.gameOver&&gameState.activeOrder&&!gameState.hasFinishedDesign&&(!gameState.modalOpen||gameState.modalOpen==='details'));
  components.hidden=!collecting;
  if(!collecting)return;
  components.innerHTML=MATERIAL_CATEGORIES.map(category=>{
    const count=categoryTotal(category);
    return `<span class="${count>0?'owned':''}" aria-label="${CATEGORY_LABELS[category]}: ${count} collected, 1 required">${categoryIcon(category)}${CATEGORY_LABELS[category]}<b>${count}/1</b></span>`;
  }).join('')+`<small class="personal-preferences">${personalTouchText(gameState.activeOrder.customerId)?`LOVES · ${personalTouchText(gameState.activeOrder.customerId)} · OPTIONAL`:''}</small>`;
}
function updateHUD() {
  document.querySelector('#coins-value').textContent = hudCountup?.display.coins??gameState.coins;
  document.querySelector('#capacity-value').textContent = `${totalMaterials()}/${gameState.bagCapacity}`;
  document.querySelector('#materials-value').innerHTML = `<span title="Garments">${iconMarkup('dress')}×${categoryTotal('garments')}</span><span title="Dyes"><i class="material-dot"></i>×${categoryTotal('dyes')}</span><span title="Patches">${iconMarkup('star')}×${categoryTotal('motifs')}</span><span title="Trims">${iconMarkup('bow')}×${categoryTotal('trims')}</span>`;
  const target = targetCustomer();
  document.querySelector('#orders-button').classList.toggle('hidden',Boolean(gameState.activeOrder)||gameState.practice);
  const targetCard=document.querySelector('#target-card');
  targetCard.classList.toggle('hidden',!target);
  if (target && gameState.activeOrder) {
    document.querySelector('#collection-heading').textContent=gameState.hasFinishedDesign?'DELIVER YOUR LOOK':'BUILD YOUR LOOK';
    document.querySelector('#target-name').textContent = target.name.toUpperCase();
    document.querySelector('#target-look').textContent = `→ ${DISTRICTS.find(item=>item.id===gameState.activeOrder.destinationId).name} · ${gameState.activeOrder.difficulty} ×${gameState.activeOrder.difficultyMultiplier}`;
    document.querySelector('#target-style').textContent=customerStyleText(target.id);
  }
  updateCollectionHUD();
  document.querySelectorAll('.shop-sign').forEach(sign=>sign.classList.toggle('shop-targeted',gameState.shopObjective));
  const upgrades=upgradeState();document.querySelector('#upgrade-progress').textContent=upgrades.affordable?'UPGRADE READY!':upgrades.next?`NEXT UPGRADE ${gameState.coins} / ${upgrades.next.cost}`:'UPGRADES COMPLETE';document.querySelector('#coin-stat').classList.toggle('upgrade-ready',upgrades.affordable);
  updateTimerDisplay(); updateOrderTimerDisplay(); updateScoreDisplay();
  updatePracticeGuide();
  updateCompactHUD();
  const objective = objectiveText();
  if (objective !== lastObjective) {
    const card = document.querySelector('#objective-card');
    card.classList.add('changing');
    setGameTimeout(() => { card.textContent = objective; card.classList.remove('changing'); }, 130);
    lastObjective = objective;
  }
  updateObjectiveMarker();
}

function readHighScores() {
  try {
    const value=JSON.parse(readSaved('makeYourDesignHighScoresV4')||'[]');
    return Array.isArray(value)?value.filter(entry=>entry&&['score','sales','perfectMatches','bestCombo','timestamp'].every(key=>Number.isSafeInteger(entry[key])&&entry[key]>=0)).sort((a,b)=>b.score-a.score||a.timestamp-b.timestamp).slice(0,5):[];
  } catch { return []; }
}
function storeHighScore() {
  if(gameState.practice)return {scores:readHighScores(),currentTimestamp:null,entered:false};
  const entry={score:gameState.score,sales:gameState.stats.sales,perfectMatches:gameState.stats.perfectMatches,bestCombo:gameState.bestCombo,timestamp:Date.now()};
  const previousScores=readHighScores(),previousBest=previousScores[0]?.score??null;
  const scores=[...previousScores,entry].sort((a,b)=>b.score-a.score||a.timestamp-b.timestamp).slice(0,5);
  writeSaved('makeYourDesignHighScoresV4',JSON.stringify(scores));
  return {scores,currentTimestamp:entry.timestamp,entered:scores.some(item=>item.timestamp===entry.timestamp),previousBest};
}
function renderBestScore() {
  const best=readHighScores()[0], element=document.querySelector('#best-score'); element.textContent=best?`BEST SCORE ${best.score.toLocaleString()}`:''; element.classList.toggle('hidden',!best);
}
function renderGameOver(board) {
  document.querySelector('#final-score').textContent=gameState.score.toLocaleString();
  const best=board.scores[0]?.score??gameState.score,difference=gameState.score-(board.previousBest??gameState.score);
  const comparison=board.previousBest===null?'FIRST SCORE!':difference>0?`NEW BEST! +${difference.toLocaleString()} improvement`:difference===0?'MATCHED YOUR BEST':`${(-difference).toLocaleString()} below your best`;
  document.querySelector('#best-comparison').textContent=`PERSONAL BEST ${best.toLocaleString()} · ${comparison}. Next target: ${(best+1).toLocaleString()}`;
  if(platform.storageFailed)document.querySelector('#best-comparison').textContent+=' · Saving unavailable: scores kept for this session.';
  document.querySelector('#final-stats').innerHTML=`<span>DESIGNS SOLD<b>${gameState.stats.sales}</b></span><span>NAILED IT LOOKS<b>${gameState.stats.perfectMatches}</b></span><span>BEST COMBO<b>${gameState.bestCombo}</b></span><span>LEGENDARY DESIGNS<b>${gameState.stats.legendaryDesigns}</b></span><span>CUSTOMERS ANNOYED<b>${gameState.stats.customersAnnoyed}</b></span>`;
  document.querySelector('#high-score-list').innerHTML=board.scores.map((entry,index)=>`<div class="high-score-row ${entry.timestamp===board.currentTimestamp&&board.entered?'new-score':''}"><strong>#${index+1} &nbsp; ${entry.score.toLocaleString()}</strong><span>${entry.sales} sales • ${entry.perfectMatches} nailed it</span>${entry.timestamp===board.currentTimestamp&&board.entered?'<b>NEW!</b>':''}</div>`).join('')||'<p>No scores yet</p>';
}
function endRun() {
  if(gameState.practice)return;
  if(gameState.modalOpen==='results'){
    document.querySelector('#results-modal').classList.remove('open');
    gameState.modalOpen=null;hudCountup=null;
  }
  if(gameState.gameOver)return; if(gameState.modalOpen==='bag'||gameState.modalOpen==='shop'||gameState.modalOpen==='orders')closeModal(gameState.modalOpen); gameState.timeRemaining=0; gameState.gameOver=true; gameState.timerStarted=false; velocity.set(0,0,0); activeInteraction=null; setPrompt(null); clearTemporaryDrops();
  offerInProgress=null;runGeneration++;gameTasks.clear();clearInput();syncPlatformGameplay();updateControlVisibility();
  const board=storeHighScore(); customers.forEach(customer=>customer.animation.play('idle')); renderGameOver(board); renderBestScore(); musicController.setState('gameover');syncAudio();
  setGameTimeout(()=>{if(!gameState.gameOver)return;document.querySelector('#game-over-screen').classList.add('active');document.querySelector('#hud').classList.add('hidden');},400);
}
function updateArcadeTimer(dt) {
  if(simulationSuspended()||gameState.practice||!gameState.started||gameState.gameOver||!gameState.timerStarted||choicesPauseClocks()||saleGameplayPaused()||document.visibilityState==='hidden'){updateTimerDisplay();return;}
  gameState.timeRemaining=Math.max(0,gameState.timeRemaining-dt); updateTimerDisplay(); if(gameState.timeRemaining<=0)endRun();
}
function updateOrderTimer(dt) {
  const order=gameState.activeOrder;
  if(!order||!gameState.started||gameState.gameOver){updateOrderTimerDisplay();return;}
  if(!simulationSuspended()&&!gameState.practice&&gameState.timerStarted&&!choicesPauseClocks()&&!saleGameplayPaused()&&document.visibilityState!=='hidden'){
    order.elapsedTravelTime+=dt;
    if(order.elapsedTravelTime>=order.deadlineSeconds)order.orderLate=true;
  }
  updateOrderTimerDisplay();
}
function updateOrderTimerDisplay(){
  const card=document.querySelector('#order-timer-card'),value=document.querySelector('#order-timer-value'),order=gameState.activeOrder;
  card.classList.toggle('hidden',!order);
  if(!order)return;
  value.textContent=gameState.practice?'PRACTICE':order.orderLate?(compactMode?'LATE · SELL':'LATE · STILL SELL'):formatTime(orderTimeRemaining(order));
  card.setAttribute('aria-label',gameState.practice?'Practice delivery · no time limit':order.orderLate?'Delivery late · you can still sell':`Delivery deadline ${value.textContent}`);
  card.title='Late accepted deliveries: half sale coins, lower score, −5 seconds and combo reset.';
  card.classList.toggle('late',order.orderLate);
  card.classList.toggle('warning',!order.orderLate&&orderTimeRemaining(order)<=10);
}
function updateObjectiveMarker() {
  if (!objectiveMarker) return;
  const target=navigationTarget();
  if(!target){objectiveMarker.position.y=-10;if(customerTargetRing)customerTargetRing.visible=false;return;}
  objectiveMarker.position.copy(target.point).setY(target.kind==='customer'?2.45:target.kind==='pickup'?1.9:3.1);
  if(customerTargetRing){customerTargetRing.visible=target.kind==='customer'&&!gameState.modalOpen;customerTargetRing.position.copy(target.point).setY(.04);}
}
function setPrompt(label, perfect = false) {
  const prompt = document.querySelector('#interaction-prompt');
  const changed=prompt.querySelector('span').textContent!==(label||'')||prompt.classList.contains('visible')!==Boolean(label);
  prompt.querySelector('span').textContent = label || '';
  prompt.classList.toggle('visible', Boolean(label));
  prompt.classList.toggle('perfect', Boolean(label) && perfect);
  if(changed)updateCompactHUD();
}
function pulse(id) {
  const el = document.getElementById(id);
  el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse');
}
function openModal(name) {
  document.querySelector('#toast').classList.remove('show');
  if(name==='shop')gameState.shopTab=gameState.shopObjective?'upgrades':gameState.orderOffers.length?'orders':gameState.shopTab;
  clearInput();
  gameState.modalOpen = name;
  document.querySelector(`#${name}-modal`).classList.add('open');
  if (name === 'shop') renderShop();
  if (name === 'bag') renderBag();
  if (name === 'orders') renderOrderBoard();
  if (name === 'design') musicController.setState('designing', .25);
  setPrompt(null); updateHUD();syncPlatformGameplay();updateControlVisibility();
  if(name==='details'){
    document.querySelector('#details-modal .modal-card').scrollTop=0;
    document.querySelector('#details-heading').focus({preventScroll:true});
  }else document.querySelector(`#${name}-modal button:not(:disabled)`)?.focus();
}
function closeModal(name) {
  if(gameState.modalOpen!==name||name==='results')return;
  if (name === 'design' && designRevealLocked) return;
  if(name==='design'){craftChallenge=null;designRevealToken++;pendingDesign=null;}
  document.querySelector(`#${name}-modal`).classList.remove('open');
  gameState.modalOpen = null;clearInput();
  syncPlatformGameplay();updateControlVisibility();
  if (name === 'design' && gameState.started && !gameState.gameOver) musicController.setState('gameplay', .25);
  const leavingShop=name==='shop'&&gameState.shopObjective;if(leavingShop){gameState.shopObjective=false;if(!gameState.activeOrder&&!gameState.gameOver)generateOrderOffers();}
  updateHUD();
  if(name==='details'&&compactMode)document.querySelector('#phone-details-button').focus({preventScroll:true});
}

// 20. particles/popups
const particles = [];
const saleEffects = [];
function heartGeometry() {
  const shape = new THREE.Shape();
  shape.moveTo(0, -.08);
  shape.bezierCurveTo(-.16, .02, -.14, .18, 0, .1);
  shape.bezierCurveTo(.14, .18, .16, .02, 0, -.08);
  return new THREE.ShapeGeometry(shape);
}
function burst(position, count, colour, kind = 'sphere', lifetime = .5) {
  for (let i = 0; i < count; i++) {
    let geometry = new THREE.SphereGeometry(.07, 7, 5);
    if (kind === 'coin') geometry = new THREE.CylinderGeometry(.09, .09, .035, 10);
    if (kind === 'spark') geometry = new THREE.OctahedronGeometry(.075);
    if (kind === 'heart') geometry = heartGeometry();
    if (kind === 'confetti') geometry = new THREE.BoxGeometry(.045,.14,.018);
    const heartColours = [C.coral, C.peach, C.lavender];
    const confettiColours=[C.gold,C.cream,C.coral,C.lavender,C.mint,C.peach];
    const particleMaterial = kind === 'coin' ? materials.gold : mat(kind === 'confetti'?confettiColours[i%confettiColours.length]:kind === 'heart' ? heartColours[i % 3] : (i % 3 === 0 ? C.cream : colour));
    const item = new THREE.Mesh(geometry, particleMaterial);
    item.position.copy(position);
    scene.add(item);
    const a = i / count * Math.PI * 2;
    particles.push({ mesh: item, velocity: new THREE.Vector3(Math.cos(a) * (1 + Math.random()), 1.4 + Math.random() * .6, Math.sin(a) * (1 + Math.random())), age: 0, lifetime, kind });
  }
}
function createPerfectRing(position) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(.35, .48, 48), new THREE.MeshBasicMaterial({ color:C.gold, transparent:true, opacity:.9, side:THREE.DoubleSide, depthWrite:false }));
  ring.position.copy(position).add(new THREE.Vector3(0, .05, 0));
  ring.rotation.x = -Math.PI / 2;
  scene.add(ring);
  saleEffects.push({ mesh:ring, age:0, lifetime:.7 });
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i]; p.age += dt;
    p.velocity.y -= 3.4 * dt;
    p.mesh.position.addScaledVector(p.velocity, dt);
    p.mesh.rotation.x += dt * 8; p.mesh.rotation.y += dt * 6;
    const s = Math.max(0, 1 - p.age / p.lifetime); p.mesh.scale.setScalar(s);
    if (p.age >= p.lifetime) { scene.remove(p.mesh); disposeGeneratedGroup(p.mesh); particles.splice(i, 1); }
  }
  for (let index = saleEffects.length - 1; index >= 0; index--) {
    const effect = saleEffects[index];
    effect.age += dt;
    const progress = effect.age / effect.lifetime;
    effect.mesh.scale.setScalar(1 + progress * 4);
    effect.mesh.material.opacity = Math.max(0, 1 - progress);
    if (effect.age >= effect.lifetime) {
      scene.remove(effect.mesh);
      effect.mesh.geometry.dispose();
      effect.mesh.material.dispose();
      saleEffects.splice(index, 1);
    }
  }
}
function showArcadeFeedback(type, text, duration = 700) {
  const el = document.createElement('div');
  el.className = `world-popup ${type}`;
  el.textContent = text;
  document.querySelector('#popup-layer').appendChild(el);
  setGameTimeout(() => el.remove(), duration);
  return el;
}
function popup(text, className = '') {
  const type=className||'pickup';
  showArcadeFeedback(type,text,type==='sale'||type==='perfect'?900:700);
}
let toastTimer;
function toast(text) {
  const el = document.querySelector('#toast');
  clearGameTimeout(toastTimer); el.textContent = text; el.classList.add('show');
  toastTimer = setGameTimeout(() => el.classList.remove('show'), 1500);
}

// 21. animation loop
function updateCollectionClarity(){
  const order=gameState.activeOrder;
  if(!order||teachingCollection()||gameState.hasFinishedDesign||order.collectionPulseShown)return;
  const missing=MATERIAL_CATEGORIES.filter(category=>categoryTotal(category)===0);
  if(!missing.length||gameState.activePlayTime-(order.collectionProgressAt??gameState.activePlayTime)<6)return;
  order.collectionPulseShown=true;
  document.querySelectorAll('[data-supplier-category]').forEach(marker=>marker.classList.toggle('supplier-pulse',missing.includes(marker.dataset.supplierCategory)));
}
// The production frame and deterministic checks share movement/countdown ownership.
function updateGameplayStep(rawDelta,inspectionWasPaused=false,updateWorld=()=>{}) {
  const dt=Math.min(Math.max(0,rawDelta),.05);
  if(simulationSuspended())return dt;
  if(gameState.started&&!gameState.gameOver&&!choicesPauseClocks()&&!saleGameplayPaused()&&!inspectionWasPaused){gameState.activePlayTime+=dt;gameState.guideRemaining=Math.max(0,gameState.guideRemaining-dt);}
  if(gameState.started&&!gameState.gameOver&&!choicesPauseClocks()&&!saleGameplayPaused()&&!inspectionWasPaused)updateCollectionClarity();
  const assistantDelta=gameState.timerStarted?Math.min(dt,gameState.timeRemaining):dt;
  updateAssistant(inspectionWasPaused?0:assistantDelta);
  updateMovement(dt);
  updateWorld(dt);
  updateOrderTimer(inspectionWasPaused?0:dt);
  updateArcadeTimer(inspectionWasPaused?0:dt);
  return dt;
}
function animate() {
  requestAnimationFrame(animate);
  const activeDelta=clock.getDelta(),dt=Math.min(activeDelta,.05);
  if(simulationSuspended())return;
  elapsed += dt;
  const now = gameNow();
  const inspectionWasPaused=saleGameplayPaused(now);
  updateGameTasks(now);
  updateCraftChallenge(now);
  syncPlatformGameplay();
  const gameplayPaused=saleGameplayPaused(now);
  updateGameplayStep(activeDelta,inspectionWasPaused,dt=>{
    if (playerAnimation&&!gameplayPaused) playerAnimation.mixer.update(dt);
    updateCamera(dt);
    if(!gameplayPaused){updatePickups(dt,now);updateTemporaryDrops(now);}
    updateBagFullWarning();
    updateCustomers(dt, now);
    updateObjectiveMarker();
    if (workerAnimation&&!gameplayPaused) workerAnimation.mixer.update(dt);
    if(!gameplayPaused)updateInteractions(now); else setPrompt(null);
    if(!gameState.practice&&gameState.started&&!gameState.gameOver&&!gameState.timerStarted&&titleTransitionElapsed>=.7)gameState.timerStarted=true;
    if(!gameplayPaused&&gameState.started&&!gameState.gameOver&&!gameState.activeOrder&&gameState.nextOffersAt&&now>=gameState.nextOffersAt)generateOrderOffers();
  });
  updateSaleCountup(now);
  updateParticles(dt);
  if(!gameplayPaused){updateClouds(dt);updateTownLife();}
  if(!gameplayPaused)updateArcadeTown(now);
  if (studioRing) {
    const relevant = gameState.activeOrder && (hasActiveOrderMaterials() || gameState.designRejected) && (!gameState.hasFinishedDesign || gameState.designRejected);
    studioRing.material.opacity = relevant ? .3 + Math.sin(elapsed * 3) * .09 : .16;
  }
  if(shopRing){const ready=upgradeState().affordable||gameState.shopObjective;shopRing.material.color.setHex(ready?C.gold:C.mint);shopRing.material.opacity=ready?.32+Math.sin(elapsed*4)*.1:.12;}
  if (objectiveMarker && objectiveMarker.position.y > 0) {
    const markerBase = gameState.hasFinishedDesign && !gameState.designRejected && gameState.activeOrder ? 2.45 : 3.1;
    objectiveMarker.position.y = markerBase + Math.sin(elapsed * 2.7) * .16;
    objectiveMarker.scale.setScalar(1 + Math.sin(elapsed * 3.2) * .08);
    objectiveMarker.rotation.y += dt;
  }
  if (carriedDesign) {
    carriedDesign.position.y = 1.25 + Math.sin(elapsed * 3) * .04;
    carriedDesign.children.filter(child => child.userData.sparkleOrbit).forEach(orbit => orbit.rotation.y += dt * 1.8);
  }
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  updateTownMapAndLabels(now);
}

// 22. init
function resetRunState() {
  runGeneration++;gameTasks.clear();clearInput();workerElapsed=0;
  manualPaused=false;setSuspended('manual',false);document.querySelector('#pause-screen').classList.remove('active');
  for(const particle of particles){disposeGeneratedGroup(particle.mesh);scene.remove(particle.mesh);}particles.length=0;
  for(const effect of saleEffects){disposeGeneratedGroup(effect.mesh);scene.remove(effect.mesh);}saleEffects.length=0;
  const runSeed=createRunSeed();
  Object.assign(gameState,{practice:false,practiceOffer:null,practiceFinishing:false,started:false,coins:0,inventory:createEmptyInventory(),stockroom:createEmptyInventory(),showcase:[],showcaseSequence:0,shopTab:'orders',bagLevel:1,bagCapacity:6,shopLevel:1,hasFinishedDesign:false,designRejected:false,selectedGarmentType:'DRESS',selectedColour:'LAVENDER',selectedMotif:'STAR',selectedTrim:'BOW',selectedCut:'CLASSIC',selectedAccent:'MINT',workerOwned:false,rareNextSale:false,speedBoostUntil:0,runwayRushUntil:0,activePlayTime:0,guideRemaining:0,shopObjective:false,collectionReminderShown:false,modalOpen:null,recipeDeck:[],recipeIndex:0,runSeed,rngState:runSeed,orderOffers:[],activeOrder:null,previousCustomerId:null,nextOffersAt:0,destinationPool:[],previousDestinationId:null,finishedDesign:null,timeRemaining:STARTING_TIME,timerStarted:false,score:0,streak:0,bestCombo:0,gameOver:false,stats:{sales:0,perfectMatches:0,legendaryDesigns:0,customersAnnoyed:0}});
  designRevealToken++; designRevealLocked=false; pendingDesign=null; craftChallenge=null;document.querySelector('#craft-challenge').classList.add('hidden');document.querySelector('#stop-craft').classList.add('hidden'); salePauseUntil=0; saleCelebrationCustomer=null; hudCountup=null; cameraCelebration=null;
  assignPickupSlots();
  reshuffleRecipeDeck();
  clearTownEvents();boostLanes.forEach(lane=>Object.assign(lane,{occupied:false,stage:0,locked:false,startedAt:0,hurdleJump:-1,hoopJump:-1}));jumpGates.forEach(gate=>gate.visual.material=materials.gold);lastMapUpdate=-Infinity;
  keys.clear();lastRenderedScore=-1;
  lastUrgentSecond=-1; lastObjective=''; offerInProgress=null; activeInteraction=null; velocity.set(0,0,0); player.position.set(-4,0,-4); player.rotation.set(0,0,0); jumping=false;jumpSequence=0;previousStuntPosition.copy(player.position); jumpElapsed=0; jumpCooldownUntil=0;jumpOrderCustomerId=null;collectionHistory.length=0; clearTemporaryDrops();
  clearCarriedDesign();
  document.querySelector('#popup-layer').replaceChildren();document.querySelector('#toast').classList.remove('show');
  document.querySelector('#assistant-popup').classList.remove('show');
  if(worker){workerAnimation?.mixer.stopAllAction();disposeOwnedCharacter(worker);worker.parent?.remove(worker);worker=null;} workerAnimation=null;
  customers.forEach(customer=>{clearGameTimeout(customer.speechTimer);if(customer.speechLabel)customer.wrapper.remove(customer.speechLabel);customer.speechLabel=null;customer.route=customerPatrolRoute(CUSTOMER_DEFINITIONS.find(item=>item.id===customer.id).route);customer.deliveryPath=[];customer.deliveryIndex=0;customer.atDestination=false;customer.wrapper.position.set(customer.route[0][0],0,customer.route[0][1]);customer.wrapper.rotation.set(0,0,0);customer.routeIndex=1;customer.pausedUntil=0;customer.reactionUntil=0;customer.resumeAt=0;customer.sellingPaused=false;customer.inspectUntil=0;customer.annoyance=0;customer.annoyanceVisibleUntil=0;customer.fumingUntil=0;customer.chaseUntil=0;customer.rejectionCount=0;customer.goAwayShown=false;customer.countedAnnoyed=false;customer.animation.play('idle');refreshCustomerBubble(customer);});
  pickups.forEach(pickup=>{pickup.active=true;pickup.respawnAt=0;pickup.group.visible=true;pickup.group.position.copy(pickup.anchor);});
  refreshWorldShowcase();
  document.querySelectorAll('.modal').forEach(modal=>modal.classList.remove('open')); document.querySelector('#game-over-screen').classList.remove('active'); resetStudioReveal();
}
function beginRun(fromTitle) {
  resetRunState(); initAudio(); if(audioContext?.state==='suspended')audioContext.resume().catch(()=>{}); musicController.unlock(); musicController.setState('gameplay');syncAudio();
  gameState.started=true; titleStartCamera.copy(camera.position); cameraTarget.set(0,1,0); titleTransitionElapsed=fromTitle?0:.7; gameState.timerStarted=!fromTitle;
  generateOrderOffers();
  if(!fromTitle){camera.position.copy(player.position).add(CAMERA_OFFSET);cameraTarget.copy(player.position).add(new THREE.Vector3(0,1,0));}
  document.querySelector('#title-screen').classList.remove('active'); document.querySelector('#game-over-screen').classList.remove('active'); document.querySelector('#hud').classList.remove('hidden'); updateHUD();syncPlatformGameplay();updateControlVisibility();
}
function returnToTitle() {
  resetRunState();syncPlatformGameplay();updateControlVisibility();document.querySelector('#game-over-screen').classList.remove('active');document.querySelector('#hud').classList.add('hidden');document.querySelector('#title-screen').classList.add('active');renderBestScore();musicController.setState('title');
}
function bindUI() {
  const tabs=document.querySelector('.design-tabs');
  tabs.addEventListener('click',event=>{const button=event.target.closest('[data-design-tab]');if(button&&!button.disabled)setDesignerCategory(button.dataset.designTab);});
  tabs.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||designRevealLocked)return;event.preventDefault();const buttons=[...tabs.querySelectorAll('button')],index=buttons.indexOf(document.activeElement),next=event.key==='Home'?0:event.key==='End'?5:(index+(event.key==='ArrowRight'?1:5))%6;setDesignerCategory(buttons[next].dataset.designTab);buttons[next].focus();});
  document.querySelector('#game-canvas').addEventListener('contextmenu',event=>event.preventDefault());
  document.querySelector('#touch-controls').addEventListener('contextmenu',event=>event.preventDefault());
  const unlockAudio = () => {
    initAudio();
    if (audioContext?.state === 'suspended' || audioContext?.state === 'interrupted') audioContext.resume().catch(()=>{});
    musicController.unlock();
  };
  document.addEventListener('pointerdown', unlockAudio, { capture:true });
  document.addEventListener('keydown', unlockAudio, { capture:true });
  document.querySelector('#play-button').addEventListener('click', () => { if(gameReady){if(onboardingSeen)beginRun(true);else beginPractice();} });
  document.querySelector('#play-again-button').addEventListener('click', () => beginRun(false));
  document.querySelector('#title-button').addEventListener('click', returnToTitle);
  document.querySelector('#game-over-credits-button').addEventListener('click', () => openModal('credits'));
  document.querySelector('#sound-button').addEventListener('click', () => { gameState.soundEnabled=!gameState.soundEnabled;saveSettings();syncAudio(); });
  document.querySelector('#close-shop').addEventListener('click', () => closeModal('shop'));
  document.querySelector('#shop-tabs').addEventListener('click',event=>{const button=event.target.closest('[data-shop-tab]');if(button){gameState.shopTab=button.dataset.shopTab;renderShop();}});
  document.querySelector('#orders-button').addEventListener('click',()=>{if(gameState.modalOpen==='details')closeModal('details');openOrderBoard();});
  document.querySelector('#guide-button').addEventListener('click',()=>{if(gameState.modalOpen==='details')closeModal('details');activateGuide();});document.querySelector('#next-job').addEventListener('click',()=>continueSale());document.querySelector('#visit-shop').addEventListener('click',()=>continueSale(true));
  document.querySelector('#close-orders').addEventListener('click',()=>closeModal('orders'));
  document.querySelector('#order-board-items').addEventListener('click',event=>{const button=event.target.closest('[data-accept-order]');if(button)acceptOrder(offerForCustomer(button.dataset.acceptOrder));});
  document.querySelector('#stop-craft').addEventListener('click',stopCraftChallenge);
  document.querySelector('#cut-options').addEventListener('click',event=>{const button=event.target.closest('[data-cut]');if(button&&!designRevealLocked){gameState.selectedCut=button.dataset.cut;syncDesignOptions();}});
  document.querySelector('#accent-options').addEventListener('click',event=>{const button=event.target.closest('[data-accent]');if(button&&!designRevealLocked){gameState.selectedAccent=button.dataset.accent;syncDesignOptions();}});
  document.querySelector('#shop-order-items').addEventListener('click',event=>{const button=event.target.closest('[data-accept-order]');if(button)acceptOrder(offerForCustomer(button.dataset.acceptOrder));});
  document.querySelector('#stockroom-items').addEventListener('click',event=>{const button=event.target.closest('[data-transfer]');if(button)transferStockroom(button.dataset.transfer,button.dataset.category,button.dataset.type);});
  document.querySelector('#close-bag').addEventListener('click', () => closeModal('bag'));
  document.querySelector('#close-bag-x').addEventListener('click', () => closeModal('bag'));
  document.querySelector('#bag-items').addEventListener('click', event => {
    const button = event.target.closest('[data-drop-category]');
    if (button) dropInventoryItem(button.dataset.dropCategory, button.dataset.dropType);
  });
  document.querySelector('#title-credits-button').addEventListener('click', () => openModal('credits'));
  document.querySelector('#close-credits').addEventListener('click', () => closeModal('credits'));
  document.querySelector('#cancel-design').addEventListener('click', () => closeModal('design'));
  document.querySelector('#create-design').addEventListener('click', createDesign);
  document.querySelector('#take-design').addEventListener('click', takeDesign);
  document.querySelector('#garment-options').addEventListener('click', event => { const button = event.target.closest('[data-garment]'); if (button) { gameState.selectedGarmentType = button.dataset.garment; syncDesignOptions(); } });
  document.querySelector('#colour-options').addEventListener('click', event => { const button = event.target.closest('[data-colour]'); if (button) { gameState.selectedColour = button.dataset.colour; syncDesignOptions(); } });
  document.querySelector('#motif-options').addEventListener('click', event => { const button = event.target.closest('[data-motif]'); if (button) { gameState.selectedMotif = button.dataset.motif; syncDesignOptions(); } });
  document.querySelector('#trim-options').addEventListener('click', event => { const button = event.target.closest('[data-trim]'); if (button) { gameState.selectedTrim = button.dataset.trim; syncDesignOptions(); } });
  document.querySelector('#upgrade-cards').addEventListener('click', e => { const b = e.target.closest('[data-upgrade]'); if (b) buyUpgrade(b.dataset.upgrade); });
  document.querySelectorAll('.modal-backdrop').forEach(b => b.addEventListener('click', () => { if (gameState.modalOpen) closeModal(gameState.modalOpen); }));
  bindReleaseControls();
  syncGameViewport();
  window.addEventListener('resize',syncGameViewport);
  window.visualViewport?.addEventListener('resize',syncGameViewport);
  window.visualViewport?.addEventListener('scroll',syncGameViewport);
}
async function init() {
  const status=document.querySelector('#loading-status');
  const platformReady=initPlatform();
  try {
    await document.fonts?.ready;
    status.textContent='Growing the town…';await loadNatureAssets();buildWorld();preparePickupSlots();assignPickupSlots();batchStaticWorldMeshes();
    status.textContent='Meeting your customers…';await createPlayer();await createCustomers();
    if(requiredAssetFailed)throw new Error('A required model texture could not load');
    createPickups();customerTargetRing=createFloorRing(new THREE.Vector3(),C.gold);customerTargetRing.visible=false;initTownMap();await platformReady;loadSettings();bindUI();renderBestScore();updateHUD();
    gameReady=true;
    document.querySelector('#play-button').disabled=false;document.querySelector('#practice-button').disabled=false;
    status.textContent='Ready · New here? PLAY includes a guided practice order.';
    if(platform.loading){platformEvent('loadingStop');platform.loading=false;}
    clock.getDelta();animate();
    return true;
  } catch {
    status.textContent='A required asset could not load. Check your connection, then retry.';
    document.querySelector('#retry-load').classList.remove('hidden');
    await platformReady;
    if(platform.loading){platformEvent('loadingStop');platform.loading=false;}
    return false;
  }
}
init();
