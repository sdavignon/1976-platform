import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {MySQLStore} from '../dist/mysql.js';
const run=(args,env={})=>spawnSync(process.execPath,['dist/cli.js',...args],{encoding:'utf8',env:{...process.env,...env}});
test('CLI reads commented schemas and refuses to overwrite review output',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'1976-cli-'));try{await writeFile(join(directory,'Task.jsonc'),'// schema\n{"name":"Task","type":"object"}');const output=join(directory,'review.json');let result=run(['schemas','--directory',directory,'--output',output]);assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(await readFile(output,'utf8')).policiesRequired,['Task']);result=run(['schemas','--directory',directory,'--output',output]);assert.notEqual(result.status,0);}finally{await rm(directory,{recursive:true,force:true});}
});
test('CLI plans, imports with reviewed digest and verifies a synthetic MySQL bundle',{skip:!process.env.TEST_MYSQL_URL},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'1976-import-')),app='cli-'+randomUUID(),store=new MySQLStore(process.env.TEST_MYSQL_URL,{}),env={MYSQL_URL:process.env.TEST_MYSQL_URL};
 try{await store.migrate();const file=join(directory,'data.migration.json'),receipt=join(directory,'data.receipt.json');await writeFile(file,JSON.stringify({formatVersion:1,sourceAppId:'synthetic',entities:{Task:{schema:{type:'object'},records:[{id:'old-id',title:'preserved',created_date:'2020-01-01T00:00:00Z'}]}}}));const result=run(['plan','--bundle',file,'--app',app],env);assert.equal(result.status,0,result.stderr);const plan=JSON.parse(result.stdout);assert.equal(plan.insertCount,1);const imported=run(['import','--bundle',file,'--app',app,'--digest',plan.digest,'--receipt',receipt],env);assert.equal(imported.status,0,imported.stderr);assert.equal(JSON.parse(await readFile(receipt,'utf8')).inserted[0].id,'old-id');const verified=run(['verify','--bundle',file,'--app',app],env);assert.equal(verified.status,0,verified.stderr);assert.equal(JSON.parse(verified.stdout).ok,true);
 }finally{await store.pool.execute('DELETE FROM platform_records WHERE app_id=?',[app]);await store.close();await rm(directory,{recursive:true,force:true});}
});
