import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { ResumeVersionEditor } from "@/components/resume-version-editor";
import { defaultResumeFormat } from "@/lib/documents/resume-format";

async function mounted(run: (h: {container: HTMLElement; render: (extra?: Record<string, unknown>) => Promise<void>; clickPreview: () => Promise<void>; requests: RequestInit[]; deferNext: () => () => void}) => Promise<void>) {
  const dom = new JSDOM("<html><body><div id='root'></div></body></html>", {url:"http://localhost/resumes/synthetic-version"});
  const prior = new Map<string, PropertyDescriptor | undefined>();
  const requests:RequestInit[]=[];
  let delay:Promise<void>|undefined;
  const createUrl=URL.createObjectURL,revokeUrl=URL.revokeObjectURL;
  URL.createObjectURL=()=>"blob:synthetic-pdf";URL.revokeObjectURL=()=>{};
  for (const [name,value] of Object.entries({window:dom.window,self:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,Event:dom.window.Event,IS_REACT_ACT_ENVIRONMENT:true,fetch:async (_url:unknown,init:RequestInit)=>{requests.push(init);const pending=delay;delay=undefined;if(pending)await pending;return new Response("synthetic PDF bytes",{headers:{"content-type":"application/pdf"}});}})) {
    prior.set(name,Object.getOwnPropertyDescriptor(globalThis,name));Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
  }
  const container=dom.window.document.getElementById("root")!;
  const root=createRoot(container);
  const noop=()=>{};
  const router={bfcacheId:"synthetic-fonts",back:noop,forward:noop,push:noop,replace:noop,refresh:noop,prefetch:noop};
  async function render(extra:Record<string,unknown>={}){await act(async()=>{root.render(createElement(StrictMode,null,createElement(AppRouterContext.Provider,{value:router},createElement(ResumeVersionEditor,{version:{...defaultResumeFormat,id:"synthetic-version",title:"Synthetic résumé",fullText:"Synthetic Owner\nSUMMARY\nConfirmed experience.",jobLabel:"Synthetic job",evidenceCurrent:true,...extra}}))));});}
  async function clickPreview(){await act(async()=>{const button=Array.from(container.querySelectorAll("button")).find(b=>b.textContent==="Preview actual PDF")!;assert.equal(button.disabled,false);button.click();});}
  try { await render();await run({container,render,clickPreview,requests,deferNext:()=>{let release!:()=>void;delay=new Promise<void>(resolve=>{release=resolve;});return release;}}); }
  finally {await act(async()=>root.unmount());URL.createObjectURL=createUrl;URL.revokeObjectURL=revokeUrl;for(const[name,descriptor]of prior){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);}dom.window.close();}
}

test("the résumé editor cannot no-op save a loaded PDF and retires it when evidence becomes stale", async()=>mounted(async h=>{
  assert.equal(h.container.querySelector('select[aria-label="PDF font"]')?.getAttribute("aria-label"),"PDF font");
  assert.equal(h.container.querySelector('select[aria-label="DOCX font"]')?.getAttribute("aria-label"),"DOCX font");
  await h.clickPreview();assert.equal(h.container.querySelectorAll("[data-actual-product-pdf]").length,1);
  const save=Array.from(h.container.querySelectorAll("button")).find(b=>b.textContent?.includes("Save version"))!;
  assert.equal(save.disabled,true);await act(async()=>save.click());assert.equal(h.requests.length,1);
  await h.render({evidenceCurrent:false});assert.equal(h.container.querySelectorAll("[data-actual-product-pdf]").length,0);
  assert.equal(Array.from(h.container.querySelectorAll("button")).find(b=>b.textContent==="Preview actual PDF")!.disabled,true);
}));

test("a refreshed editor retires a pending PDF and can load a new current preview", async()=>mounted(async h=>{
  const release=h.deferNext();await h.clickPreview();assert.equal(h.requests.length,1);
  await h.render({jobLabel:"Changed current server metadata"});await act(async()=>release());
  assert.equal(h.container.querySelectorAll("[data-actual-product-pdf]").length,0);
  await h.clickPreview();assert.equal(h.requests.length,2);assert.equal(h.container.querySelectorAll("[data-actual-product-pdf]").length,1);
  assert.equal(JSON.parse(String(h.requests[1]!.body)).pdfFont,"HELVETICA");
}));
