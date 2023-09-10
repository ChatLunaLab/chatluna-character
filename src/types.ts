export interface Message {
    content: string
    name: string
    id: string
    quote?: Message
}
