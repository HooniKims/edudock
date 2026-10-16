'use strict';

// The 17 시도교육청. Every one runs the same national 업무포털, 4세대 나이스 and K-에듀파인;
// only the host carries the office's code (sen.eduptl.kr, gwe.neis.go.kr, klef.gwe.go.kr).
// 경북's K-에듀파인 is the one exception, at klef.gbe.kr (checked against DNS, 2026-10-16).
const REGIONS = Object.freeze([
  { code: 'sen', name: '서울' }, { code: 'pen', name: '부산' }, { code: 'dge', name: '대구' },
  { code: 'ice', name: '인천' }, { code: 'gen', name: '광주' }, { code: 'dje', name: '대전' },
  { code: 'use', name: '울산' }, { code: 'sje', name: '세종' }, { code: 'goe', name: '경기' },
  { code: 'gwe', name: '강원' }, { code: 'cbe', name: '충북' }, { code: 'cne', name: '충남' },
  { code: 'jbe', name: '전북' }, { code: 'jne', name: '전남' }, { code: 'gbe', name: '경북' },
  { code: 'gne', name: '경남' }, { code: 'jje', name: '제주' },
].map(region => Object.freeze(region)));

const DEFAULT_REGION = 'sen';
const CODES = new Set(REGIONS.map(region => region.code));

function isRegionCode(value) {
  return typeof value === 'string' && CODES.has(value);
}

function regionName(code) {
  return REGIONS.find(region => region.code === code)?.name ?? null;
}

function regionHosts(code) {
  const region = isRegionCode(code) ? code : DEFAULT_REGION;
  return {
    portal: `${region}.eduptl.kr`,
    neis: `${region}.neis.go.kr`,
    edufine: region === 'gbe' ? 'klef.gbe.kr' : `klef.${region}.go.kr`,
  };
}

function regionOrigins(code) {
  const hosts = regionHosts(code);
  return { portal: `https://${hosts.portal}`, neis: `https://${hosts.neis}`, edufine: `https://${hosts.edufine}` };
}

// The office the teacher picked. Main sets it from settings at launch and whenever it changes;
// everything that checks a host reads it from here, so one switch moves the whole app.
let active = DEFAULT_REGION;

function setActiveRegion(code) {
  active = isRegionCode(code) ? code : DEFAULT_REGION;
  return active;
}

function activeRegion() { return active; }
function activeOrigins() { return regionOrigins(active); }

module.exports = { REGIONS, DEFAULT_REGION, isRegionCode, regionName, regionHosts, regionOrigins, setActiveRegion, activeRegion, activeOrigins };
