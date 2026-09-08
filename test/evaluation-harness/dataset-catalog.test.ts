import test from 'node:test';
import assert from 'node:assert/strict';
import { datasetCards } from '../../src/components/evaluation-harness/dataset-catalog';
const asset=(id:string,key:string,version:number,archived=false,kind='dataset'):any=>({id,assetKey:key,name:'同名评测集',version,archived,kind,content:{cases:[{id:'case'}]}});
test('同一评测集只显示最新可用版本卡片，不按名称合并不同资产',()=>{
 const cards=datasetCards([asset('a1','a',1),asset('a3','a',3,true),asset('a2','a',2),asset('b1','b',1),asset('target','other',1,false,'target')]);
 assert.equal(cards.length,2);assert.equal(cards[0].versionAssetId,'a2');assert.ok(cards[0].tags.includes('3 个版本'));assert.equal(cards[1].versionAssetId,'b1');assert.equal(cards[0].caseCount,1);
});
test('全归档资产不显示可执行卡片',()=>assert.equal(datasetCards([asset('a','a',1,true)]).length,0));
