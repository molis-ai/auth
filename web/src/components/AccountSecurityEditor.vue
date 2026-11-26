<script setup lang="ts">
import type { AccountClient } from '../lib/account-client.ts';
import AuthenticationPanel from './AuthenticationPanel.vue';
defineProps<{client: AccountClient; authorizationPopup?: Window | null; securityAction: string; reauth: string; newIdentity: boolean; binding?: {bindingId:string;type:string}; target: Record<string,string>; busy:boolean}>();
const emit = defineEmits<{verified:[value:{handle:string}]; cancel:[]; finish:[handle?:string]}>();
</script>
<template>
        <div class="security-editor">
          <AuthenticationPanel
            v-if="!reauth"
            :key="
              securityAction +
              (binding?.bindingId ?? '') +
              (binding?.type ?? '')
            "
            :client="client"
            :blocked="busy"
            :operation="securityAction"
            :target="target"
            @complete="emit('verified', $event)"
            @cancel="emit('cancel')"
          /><AuthenticationPanel
            v-else-if="newIdentity"
            :key="reauth"
            :client="client"
            :blocked="busy"
            purpose="BIND"
            :parent="reauth"
            :authorization-popup="authorizationPopup"
            :identity-type="binding?.type"
            @complete="(v) => emit('finish', v.handle)"
            @cancel="emit('cancel')"
          />
          <div v-else class="console-actions">
            <button type="button" :disabled="busy" @click="emit('finish')">确认提交</button>
            <button type="button" :disabled="busy" @click="emit('cancel')">取消</button>
          </div>
        </div>

</template>
