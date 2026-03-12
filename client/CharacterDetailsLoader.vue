<template>
    <ConfigNav v-if="isOwn" />
</template>

<script setup lang="ts">
import { ComputedRef, inject, ref } from 'vue'
import ConfigNav from './components/ConfigNav.vue'

const pluginName = inject<ComputedRef<string>>('plugin:name')
const isOwn = ref(pluginName?.value === 'koishi-plugin-chatluna-character')
</script>
