import { Context } from '@koishijs/client'
import CharacterDetailsLoader from './CharacterDetailsLoader.vue'

export default (ctx: Context) => {
    ctx.slot({
        type: 'plugin-details',
        component: CharacterDetailsLoader,
        order: -998
    })
}
