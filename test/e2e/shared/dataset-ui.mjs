import path from 'node:path';
import assert from 'node:assert/strict';
import {writePrivate} from './runtime.mjs';
import {assertConstructedDataset} from './dataset-contract.mjs';

export async function createDatasetThroughUi({page,baseUrl,root,api,username,datasetName,recipe,readOwner,shot}) {
 const file=path.join(root,'private/dataset-import.json');writePrivate(file,[{input:recipe.input,expected_output:recipe.reference}]);
 await page.goto(baseUrl+'/dataset');await page.getByRole('button',{name:'新建评测集',exact:true}).click();
 const chooser=page.waitForEvent('filechooser');chooser.catch(()=>{});await page.getByRole('menuitem',{name:'导入本地文件',exact:true}).click();await (await chooser).setFiles(file);
 const dialog=page.getByRole('dialog',{name:'新建评测集',exact:true});await dialog.getByPlaceholder('请输入评测集名称').fill(datasetName);
 const saved=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/agent-datasets'&&r.request().method()==='POST');saved.catch(()=>{});
 await dialog.getByRole('button',{name:'保存评测集',exact:true}).click();const response=await saved,result=await response.json();assert.ok(response.ok(),result.error);assert.equal(result.success,true);
 await page.waitForURL(url=>url.pathname===`/dataset/${result.dataset.id}`);
 const dataset=await api(`/api/agent-datasets/${result.dataset.id}?user=${encodeURIComponent(username)}`),owner=readOwner(dataset.id);
 const proof=assertConstructedDataset(dataset,recipe,datasetName,username,owner);assert.equal(owner,username);
 await page.reload();const row=page.locator(`#case-${proof.case.id}`);await row.waitFor();
 const table=row.locator('xpath=ancestor::table');
 for(const [key,text]of [['input',recipe.input],['reference_output',recipe.reference]]){
  const field=dataset.fields.find(field=>field.key===key);assert.ok(field,`Dataset is missing field ${key}`);
  const header=table.getByRole('columnheader',{name:field.label,exact:true});
  const index=await header.evaluate(th=>th.cellIndex);
  const cell=row.getByRole('cell').nth(index);await cell.hover();await cell.locator('div').waitFor();assert.equal(await cell.locator('div').innerText(),text);
 }
 await shot('dataset');await page.mouse.move(0,0);
 writePrivate(path.join(root,'private/constructed-dataset.json'),dataset);return {dataset,proof};
}
