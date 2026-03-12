<template>
    <div
        data-character-nav="1"
        :class="[$style.container, isCollapsed ? $style.collapsed : '']"
        :style="containerPosition"
    >
        <div
            :class="$style.header"
            @mousedown="startMove"
            @touchstart="startMove"
        >
            <IconMove :class="$style.move" />
            <div
                :class="$style.toggle"
                @click="toggleCollapse"
                @mousedown.stop
                @touchstart.stop
            >
                <IconChevronDown />
            </div>
        </div>
        <div :class="$style.body">
            <div :class="$style.section">
                <div :class="$style.sectionTitle">配置</div>
                <div
                    :class="[$style.item, activeItem === 'base' ? $style.active : '']"
                    @click="toTop('base')"
                >
                    基础配置
                </div>
                <div
                    :class="[$style.item, activeItem === 'global-private' ? $style.active : '']"
                    @click="toTop('global-private')"
                >
                    全局私聊
                </div>
                <div
                    :class="[$style.item, activeItem === 'global-group' ? $style.active : '']"
                    @click="toTop('global-group')"
                >
                    全局群聊
                </div>
            </div>

            <div v-if="privateItems.length > 0" :class="$style.section">
                <div :class="$style.sectionTitle">私聊</div>
                <div
                    v-for="(item, i) in privateItems"
                    :key="`private-${i}`"
                    :class="[
                        $style.item,
                        activeItem === `private-${item.id}` ? $style.active : ''
                    ]"
                    @click="toItem(item.id, 'privateConfigs', 'private')"
                >
                    {{ item.label }}
                </div>
            </div>

            <div v-if="groupItems.length > 0" :class="$style.section">
                <div :class="$style.sectionTitle">群聊</div>
                <div
                    v-for="(item, i) in groupItems"
                    :key="`group-${i}`"
                    :class="[
                        $style.item,
                        activeItem === `group-${item.id}` ? $style.active : ''
                    ]"
                    @click="toItem(item.id, 'configs', 'group')"
                >
                    {{ item.label }}
                </div>
            </div>

        </div>
    </div>
</template>

<script setup lang="ts">
import {
    ComputedRef,
    computed,
    inject,
    onUnmounted,
    reactive,
    ref,
    watch
} from 'vue'
import IconMove from '../icons/IconMove.vue'
import IconChevronDown from '../icons/IconChevronDown.vue'

interface Item {
    id: string
    label: string
}

interface Cfg {
    remark?: string
}

interface CharacterConfig {
    privateConfigs?: Record<string, Cfg>
    configs?: Record<string, Cfg>
}

const isCollapsed = ref(false)
const activeItem = ref('')

const current = inject<ComputedRef<{ config: CharacterConfig }>>(
    'manager.settings.current'
)

const privateItems = computed(() => {
    const data = current?.value?.config?.privateConfigs ?? {}
    return Object.entries(data).map(([id, val]) => ({
        id,
        label: val?.remark?.trim() || id
    })) as Item[]
})

const groupItems = computed(() => {
    const data = current?.value?.config?.configs ?? {}
    return Object.entries(data).map(([id, val]) => ({
        id,
        label: val?.remark?.trim() || id
    })) as Item[]
})

const mouseInfo = reactive({
    ing: false,
    top: 100,
    right: 20,
    startTop: 0,
    startRight: 0,
    startX: 0,
    startY: 0,
    width: 0,
    height: 0
})

const containerPosition = computed(() => {
    return {
        top: mouseInfo.top + 'px',
        right: mouseInfo.right + 'px'
    }
})

const toggleCollapse = (e: MouseEvent) => {
    e.stopPropagation()
    isCollapsed.value = !isCollapsed.value
}

const onMousemove = (ev: MouseEvent | TouchEvent) => {
    const e = ev instanceof TouchEvent
        ? (ev.touches[0] as unknown as MouseEvent)
        : ev

    if (!mouseInfo.ing) {
        return
    }

    let top = mouseInfo.startTop + (e.clientY - mouseInfo.startY)
    let right = mouseInfo.startRight - (e.clientX - mouseInfo.startX)

    const boundary = document
        .querySelector('.plugin-view')
        ?.getBoundingClientRect()

    let minTop = 0
    let maxTop = window.innerHeight - mouseInfo.height
    let minRight = 0
    let maxRight = window.innerWidth - mouseInfo.width

    if (boundary) {
        minTop = boundary.top
        maxTop = boundary.bottom - mouseInfo.height
        minRight = window.innerWidth - boundary.right
        maxRight = window.innerWidth - boundary.left - mouseInfo.width
    }

    if (top < minTop) top = minTop
    if (top > maxTop) top = maxTop
    if (right < minRight) right = minRight
    if (right > maxRight) right = maxRight

    mouseInfo.top = top
    mouseInfo.right = right
}

const startMove = (ev: MouseEvent | TouchEvent) => {
    const e = ev instanceof TouchEvent
        ? (ev.touches[0] as unknown as MouseEvent)
        : ev

    const rect = (e.target as HTMLElement)
        .closest('[data-character-nav="1"]')
        ?.getBoundingClientRect()

    if (rect) {
        mouseInfo.width = rect.width
        mouseInfo.height = rect.height
    }

    mouseInfo.startTop = mouseInfo.top
    mouseInfo.startRight = mouseInfo.right
    mouseInfo.startX = e.clientX
    mouseInfo.startY = e.clientY
    mouseInfo.ing = true
}

const endMove = () => {
    mouseInfo.ing = false
}

window.addEventListener('mousemove', onMousemove)
window.addEventListener('mouseup', endMove)
window.addEventListener('touchmove', onMousemove)
window.addEventListener('touchend', endMove)

onUnmounted(() => {
    window.removeEventListener('mousemove', onMousemove)
    window.removeEventListener('mouseup', endMove)
    window.removeEventListener('touchmove', onMousemove)
    window.removeEventListener('touchend', endMove)
    observer?.disconnect()
})

const getText = (node: HTMLElement) => {
    return `${node.innerHTML}\n${node.textContent || ''}`
}

const toTop = (id: 'base' | 'global-private' | 'global-group') => {
    const nodes = document.querySelectorAll('.k-schema-left')

    const keys = {
        base: ['privateWhitelistMode', 'groupWhitelistMode', 'applyPrivate'],
        'global-private': ['globalPrivateConfig.model'],
        'global-group': ['globalGroupConfig.model']
    }

    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i] as HTMLElement
        const text = getText(node)
        if (keys[id].some((key) => text.includes(key))) {
            node.scrollIntoView({ block: 'center' })
            activeItem.value = id
            return
        }
    }
}

const toItem = (
    id: string,
    field: 'privateConfigs' | 'configs',
    type: 'private' | 'group'
) => {
    const nodes = document.querySelectorAll('.k-schema-left')
    const marks = [
        `${field}.${id}.`,
        `${field}[${id}].`
    ]

    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i] as HTMLElement
        const text = getText(node)
        if (marks.some((mark) => text.includes(mark))) {
            node.scrollIntoView({ block: 'center' })
            activeItem.value = `${type}-${id}`
            return
        }
    }
}

const map = new Map<Element, string>()
let observer: IntersectionObserver | null = null

const initObserver = () => {
    if (observer) {
        observer.disconnect()
        map.clear()
    }

    observer = new IntersectionObserver((entries) => {
        for (const e of entries) {
            if (e.isIntersecting) {
                const id = map.get(e.target)
                if (id) {
                    activeItem.value = id
                }
            }
        }
    }, {
        root: null,
        rootMargin: '-40% 0px -40% 0px',
        threshold: 0
    })

    const nodes = document.querySelectorAll('.k-schema-left')
    const mark = (
        id: string,
        test: (text: string) => boolean
    ) => {
        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i] as HTMLElement
            if (test(getText(node))) {
                observer?.observe(node)
                map.set(node, id)
                return
            }
        }
    }

    mark('base', (text) => {
        return text.includes('privateWhitelistMode')
    })
    mark('global-private', (text) => {
        return text.includes('globalPrivateConfig.model')
    })
    mark('global-group', (text) => {
        return text.includes('globalGroupConfig.model')
    })

    for (const item of privateItems.value) {
        mark(`private-${item.id}`, (text) => {
            return text.includes(`privateConfigs.${item.id}.`) ||
                text.includes(`privateConfigs[${item.id}].`)
        })
    }

    for (const item of groupItems.value) {
        mark(`group-${item.id}`, (text) => {
            return text.includes(`configs.${item.id}.`) ||
                text.includes(`configs[${item.id}].`)
        })
    }
}

watch(() => [privateItems.value, groupItems.value], () => {
    setTimeout(initObserver, 1000)
}, {
    immediate: true
})
</script>

<style module lang="scss">
.container {
    position: absolute;
    z-index: 1000;
    width: 200px;
    max-width: 90vw;
    max-height: 70vh;
    background: var(--k-card-bg);
    border-radius: 8px;
    box-shadow: var(--k-card-shadow);
    display: flex;
    flex-direction: column;
    border: 1px solid var(--k-card-border);
    font-family:
        'Helvetica Neue', Helvetica, 'PingFang SC', 'Hiragino Sans GB',
        'Microsoft YaHei', '微软雅黑', Arial, sans-serif;
    user-select: none;
    overflow: hidden;
    transition: box-shadow 0.3s ease;

    @media (max-width: 768px) {
        width: 160px;
        max-height: 50vh;
    }

    &:hover {
        box-shadow: var(
            --k-card-shadow-hover,
            0 4px 16px rgba(0, 0, 0, 0.15)
        );
    }
}

.header {
    padding: 4px 8px;
    border-bottom: 1px solid var(--k-color-divider, #ebeef5);
    background-color: var(--k-hover-bg);
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: move;
    transition: background-color 0.2s;

    &:hover {
        background-color: var(--k-activity-bg);
    }
}

.move {
    color: var(--k-text-light);
    cursor: grab;
    transition: color 0.2s;

    &:active {
        cursor: grabbing;
        color: var(--k-color-primary);
    }
}

.toggle {
    cursor: pointer;
    color: var(--k-text-light);
    transition: transform 0.3s ease, color 0.2s;
    display: flex;
    align-items: center;

    &:hover {
        color: var(--k-text-active);
    }
}

.body {
    overflow-y: auto;
    padding: 4px 0;
    transition: max-height 0.3s ease, opacity 0.3s ease;
    opacity: 1;

    &::-webkit-scrollbar {
        width: 6px;
    }

    &::-webkit-scrollbar-thumb {
        background: var(--k-scroll-thumb);
        border-radius: 3px;
    }

    &::-webkit-scrollbar-track {
        background: transparent;
    }
}

.collapsed {
    max-height: 32px !important;

    .header {
        border-bottom: none;
    }

    .body {
        max-height: 0;
        padding: 0;
        opacity: 0;
        overflow: hidden;
    }

    .toggle {
        transform: rotate(-90deg);
    }
}

.section {
    margin-bottom: 4px;
}

.sectionTitle {
    padding: 6px 12px;
    font-size: 12px;
    font-weight: 600;
    color: var(--k-text-light);
    background-color: var(--k-bg-light);
    text-transform: uppercase;
    letter-spacing: 0.5px;
}

.item {
    padding: 8px 16px;
    font-size: 13px;
    color: var(--k-text-normal);
    cursor: pointer;
    transition: background-color 0.2s, color 0.2s;
    white-space: normal;
    word-break: break-word;
    overflow-wrap: anywhere;
    border-left: 3px solid transparent;

    &:hover {
        background-color: var(--k-hover-bg);
        color: var(--k-text-active);
    }
}

.active {
    color: var(--k-color-primary);
    background-color: var(--k-activity-bg);
    font-weight: 500;
    border-left-color: var(--k-color-primary);
}

</style>
