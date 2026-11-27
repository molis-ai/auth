<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { accountErrorMessage } from '../../shared/api/errors.ts';
const props = defineProps<{ file:File; apply:(image:string)=>Promise<void> }>();
const emit = defineEmits<{ close:[] }>();
const modal=ref<HTMLDialogElement>(), stage=ref<SVGSVGElement>();
const zoom=ref(1), x=ref(0), y=ref(0), width=ref(0), height=ref(0), ready=ref(false), saving=ref(false), error=ref('');
const source = ref('');
let picture: HTMLCanvasElement | undefined;
let active=true, drag: {id:number;x:number;y:number;left:number;top:number}|undefined;
const scale=computed(()=>240/Math.min(width.value||1,height.value||1)*zoom.value);
const renderedWidth=computed(()=>width.value*scale.value), renderedHeight=computed(()=>height.value*scale.value);
function clamp() { x.value=Math.max(-(renderedWidth.value-240)/2,Math.min((renderedWidth.value-240)/2,x.value)); y.value=Math.max(-(renderedHeight.value-240)/2,Math.min((renderedHeight.value-240)/2,y.value)); }
watch(zoom,clamp);
let frame = 0;
let position: {x: number; y: number} | undefined;
function down(event: PointerEvent) {
  if (!ready.value || saving.value) return;
  stage.value?.setPointerCapture(event.pointerId);
  drag = {id:event.pointerId,x:event.clientX,y:event.clientY,left:x.value,top:y.value};
}
function updateDrag() {
  frame = 0;
  if (!drag || !position) return;
  const factor = 480 / (stage.value?.getBoundingClientRect().width || 480);
  x.value = drag.left + (position.x - drag.x) * factor;
  y.value = drag.top + (position.y - drag.y) * factor;
  position = undefined;
  clamp();
}
function move(event: PointerEvent) {
  if (drag?.id !== event.pointerId) return;
  position = {x:event.clientX,y:event.clientY};
  if (!frame) frame = requestAnimationFrame(updateDrag);
}
function endDrag() {
  if (frame) cancelAnimationFrame(frame);
  updateDrag();
  drag = undefined;
}
function key(event:KeyboardEvent) { const shifts:Record<string,[number,number]>={ArrowLeft:[-8,0],ArrowRight:[8,0],ArrowUp:[0,-8],ArrowDown:[0,8]};const shift=shifts[event.key];if(!shift||saving.value)return;event.preventDefault();x.value+=shift[0];y.value+=shift[1];clamp(); }
function close() { if(!saving.value)emit('close'); }
async function save() {
  if (!picture || !ready.value || saving.value) return;
  saving.value=true;error.value='';
  try {
    const canvas=document.createElement('canvas');let result='';
    for(const size of [256,192,128]) {
      canvas.width=size;canvas.height=size;
      const context=canvas.getContext('2d');if(!context)throw Error('无法处理图片，请重试');
      context.drawImage(picture,(width.value-240/scale.value)/2-x.value/scale.value,(height.value-240/scale.value)/2-y.value/scale.value,240/scale.value,240/scale.value,0,0,size,size);
      result = canvas.toDataURL('image/png');
      const encodedLength = result.length - 'data:image/png;base64,'.length;
      const padding = result.endsWith('==') ? 2 : result.endsWith('=') ? 1 : 0;
      if (encodedLength * 3 / 4 - padding <= 100000) break;
    }
    await props.apply(result);
    if(active)emit('close');
  } catch(cause) { if(active)error.value=accountErrorMessage(cause); }
  finally { if(active)saving.value=false; }
}
onMounted(async()=>{
  modal.value?.showModal();
  try {
    const bitmap = await createImageBitmap(props.file);
    try {
      if (!active) return;
      if (bitmap.width > 16000 || bitmap.height > 16000) throw Error('图片尺寸过大');
      const ratio = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
      const preview = document.createElement('canvas');
      preview.width = Math.max(1, Math.round(bitmap.width * ratio));
      preview.height = Math.max(1, Math.round(bitmap.height * ratio));
      const context = preview.getContext('2d');
      if (!context) throw Error('图片无法读取');
      context.drawImage(bitmap, 0, 0, preview.width, preview.height);
      picture = preview;
      width.value = preview.width;
      height.value = preview.height;
      source.value = preview.toDataURL('image/png');
      ready.value = true;
    } finally { bitmap.close(); }
  } catch { if (active) error.value = '图片无法读取或尺寸过大，请重新选择'; }
});
onBeforeUnmount(() => {
  active = false;
  if (frame) cancelAnimationFrame(frame);
  modal.value?.close();
  picture = undefined;
  source.value = '';
});
</script>
<template>
  <dialog ref="modal" class="avatar-crop-dialog" aria-labelledby="avatar-crop-title" @cancel.prevent="close">
    <header><h2 id="avatar-crop-title">调整您的图片</h2><button type="button" aria-label="关闭图片调整" :disabled="saving" @click="close">×</button></header>
    <div class="avatar-crop-content">
      <svg v-if="ready" ref="stage" class="avatar-crop-stage" viewBox="0 0 480 320" tabindex="0" role="img" aria-label="拖动图片调整头像位置，也可使用方向键" @pointerdown="down" @pointermove="move" @pointerup="endDrag" @pointercancel="endDrag" @lostpointercapture="endDrag" @keydown="key">
        <defs>
          <clipPath id="avatar-crop-circle"><circle cx="240" cy="160" r="120"/></clipPath>
          <clipPath id="avatar-crop-side-arcs"><path d="M80 40C32 112 32 208 80 280H400C448 208 448 112 400 40Z"/></clipPath>
          <linearGradient id="avatar-crop-fade" x1="0" x2="1"><stop offset="0" stop-color="black"/><stop offset=".16" stop-color="white"/><stop offset=".84" stop-color="white"/><stop offset="1" stop-color="black"/></linearGradient>
          <mask id="avatar-crop-soft-mask"><rect x="40" y="40" width="400" height="240" fill="url(#avatar-crop-fade)"/></mask>
          <filter id="avatar-crop-blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="3"/></filter>
        </defs>
        <g filter="url(#avatar-crop-blur)"><g clip-path="url(#avatar-crop-side-arcs)" mask="url(#avatar-crop-soft-mask)" opacity=".24"><image :href="source" :x="240-renderedWidth/2+x" :y="160-renderedHeight/2+y" :width="renderedWidth" :height="renderedHeight"/></g></g>
        <image :href="source" :x="240-renderedWidth/2+x" :y="160-renderedHeight/2+y" :width="renderedWidth" :height="renderedHeight" clip-path="url(#avatar-crop-circle)"/>

      </svg>
      <p v-else role="status">{{ error ? '请选择其他图片' : '正在读取图片…' }}</p>
      <div class="avatar-zoom"><button type="button" aria-label="缩小图片" :disabled="!ready||saving||zoom<=1" @click="zoom=Math.max(1,zoom-.1)">−</button><input v-model.number="zoom" type="range" min="1" max="3" step="0.01" aria-label="缩放图片" :disabled="!ready||saving"><button type="button" aria-label="放大图片" :disabled="!ready||saving||zoom>=3" @click="zoom=Math.min(3,zoom+.1)">+</button></div>
      <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    </div>
    <footer><button type="button" :disabled="saving" @click="close">取消</button><button type="button" class="avatar-crop-save" :disabled="!ready||saving" @click="save">{{ saving ? '正在保存…' : '保存' }}</button></footer>
  </dialog>
</template>
