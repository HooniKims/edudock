'use strict';

// The 17 시도교육청. They run the same 업무포털, 나이스 and K-에듀파인; only the host carries the
// office code (sen.eduptl.kr, gwe.neis.go.kr, klef.gwe.go.kr). 경북's K-에듀파인 is the one
// exception, at klef.gbe.kr. Shared by the background worker (importScripts) and the pages.
const REGIONS = [
  ['sen', '서울'], ['pen', '부산'], ['dge', '대구'], ['ice', '인천'], ['gen', '광주'], ['dje', '대전'],
  ['use', '울산'], ['sje', '세종'], ['goe', '경기'], ['gwe', '강원'], ['cbe', '충북'], ['cne', '충남'],
  ['jbe', '전북'], ['jne', '전남'], ['gbe', '경북'], ['gne', '경남'], ['jje', '제주'],
].map(([code, name]) => ({ code, name }));

const SYSTEM_NAMES = { portal: '업무포털', edufine: 'K-에듀파인', neis: '나이스' };

function isRegionCode(value) {
  return REGIONS.some(region => region.code === value);
}

function regionName(code) {
  const region = REGIONS.find(candidate => candidate.code === code);
  return region ? region.name : null;
}

function regionHosts(code) {
  return {
    portal: `${code}.eduptl.kr`,
    edufine: code === 'gbe' ? 'klef.gbe.kr' : `klef.${code}.go.kr`,
    neis: `${code}.neis.go.kr`,
  };
}

function regionPatterns(code) {
  return Object.values(regionHosts(code)).map(host => `https://${host}/*`);
}

const ALL_PATTERNS = REGIONS.flatMap(region => regionPatterns(region.code));

// Which office and which system a host belongs to, or null for anything else.
function describeHost(host) {
  for (const region of REGIONS) {
    const hosts = regionHosts(region.code);
    for (const system of Object.keys(hosts)) {
      if (hosts[system] === host) return { region: region.code, regionName: region.name, system, systemName: SYSTEM_NAMES[system] };
    }
  }
  return null;
}
