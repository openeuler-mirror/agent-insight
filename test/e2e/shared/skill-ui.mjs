import {poll} from './runtime.mjs';
export async function selectFormalSkill(page,name,version){
 const skill=page.getByRole('combobox',{name:'选择 Skill',exact:true});
 const versions=page.getByRole('combobox',{name:'选择 Skill 版本',exact:true});
 await poll(()=>skill.isEnabled(),Boolean,45000,100);
 if(await skill.inputValue()!==name)await skill.selectOption(name);
 await poll(async()=>await skill.isEnabled()&&await versions.isEnabled()&&await skill.inputValue()===name,Boolean,45000,100);
 if(await versions.inputValue()!==String(version))await versions.selectOption(String(version));
 await poll(async()=>await skill.isEnabled()&&await versions.isEnabled()&&await skill.inputValue()===name&&await versions.inputValue()===String(version),Boolean,45000,100);
}
