<script setup lang="ts">
import { ref } from 'vue';
import type { AccountClient } from '../../sdk/browser/src/index.ts';
import AuthenticationPanel from './AuthenticationPanel.vue';
defineProps<{client: AccountClient; authorizationPopup?: Window | null; securityAction: string; reauth: string; newIdentity: boolean; binding?: {bindingId:string;type:string}; target: Record<string,string>; busy:boolean}>();
const newPassword = defineModel<string>('newPassword', {default:''});
const confirmPassword = defineModel<string>('confirmPassword', {default:''});
const error = ref('');
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
          <p v-if="error" role="alert">{{ error }}</p><form
            v-if="reauth && securityAction === 'CHANGE_PASSWORD'"
            @submit.prevent="
              newPassword === confirmPassword
                ? emit('finish')
                : (error = '两次密码不一致')
            "
          >
            <label
              >新密码<input
                v-model="newPassword"
                type="password"
                autocomplete="new-password"
                required /></label
            ><label
              >确认密码<input
                v-model="confirmPassword"
                type="password"
                autocomplete="new-password"
                required /></label
            ><button :disabled="busy">确认修改密码</button><button type="button" :disabled="busy" @click="emit('cancel')">取消</button>
          </form></div>

</template>
