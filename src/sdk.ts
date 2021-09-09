import { w3cwebsocket, IMessageEvent, ICloseEvent } from "websocket";
import { Buffer } from "buffer";
import log from 'loglevel-es';
import { Command, LogicPkt, MagicBasicPktInt, MessageType, Ping } from "./packet";
import { Flag, Status } from "./proto/common";
import { 
    LoginReq, 
    LoginResp, 
    MessageReq, 
    MessageResp, 
    MessagePush, 
    GroupCreateResp, 
    GroupGetResp, 
    MessageIndexResp, 
    MessageContentResp, 
    ErrorResp, 
    KickoutNotify, 
    MessageAckReq, 
    MessageIndexReq, 
    MessageIndex, 
    MessageContentReq, 
    MessageContent, 
    GroupCreateReq, 
    GroupJoinReq, 
    GroupQuitReq, 
    GroupGetReq  
} from "./proto/protocol";
import { doLogin, LoginBody } from './login';
import Long from 'long';
import localforage from 'localforage';
import { SCOPABLE_TYPES, tsConstructorType } from "@babel/types";

// 心跳检测
const heartbeatInterval = 55 * 1000
// 发送时间
const sendtime = 5 * 1000

enum TimeUnit {
    Second = 1000,
    Millisecond = 1
}

export let sleep = async (second: number, Unit: TimeUnit = TimeUnit.Second): Promise<void> =>{
    return new Promise((resolve, _) => {
        setTimeout(()=>{
            resolve()
        },second * Unit)
    })
}

export enum State {
    INIT,
    CONNECTING,
    CONNECTED,
    RECONNECTING,
    CLOSEING,
    CLOSED
}

// 自定义状态码范围
export enum KIMStatus {
    RequestTimeout = 10,
    SendFailed = 11,
}

export enum KIMEvent {
    Reconnecting = "Reconnecting", // 重连中
    Reconnected = "Reconnected", // 重连成功
    Closed = "Closed", //
    Kickout = "kickout" // 被踢
}

export class Response {
    status: number
    dest?:string
    payload: Uint8Array
    constructor(status: number, dest?: string, payload: Uint8Array = new Uint8Array()) {
        this.status = status
        this.dest = dest
        this.payload = payload
    }
}

export class Request {
    sendTime: Number
    data: LogicPkt
    callback: (response: LogicPkt) => void
    constructor(data: LogicPkt, callback: (response: LogicPkt)=>void) {
        this.sendTime = Date.now()
        this.data = data
        this.callback = callback
    }
}

const pageCount = 50

// 获取离线信息
export class OfflineMessages {
    private cli: KIMClient
    private groupmessages = new Map<string, Message[]>() // 用来保存对应群的信息
    private usermessages = new Map<string, Message[]>()  // 用来保存对应好友的信息
    constructor(cli: KIMClient, indexes: MessageIndex[]){
        this.cli = cli
        // 因为通常离线信息的读取是从上往下读取的，因此倒叙
        for (let index = indexes.length -1; index >= 0; index--) {
            const idx = indexes[index]
            let message = new Message(idx.messageId, idx.sendTime)
            if (idx.direction == 1) {
                message.sender = cli.account
                message.receiver = idx.accountB
            } else {
                message.sender = idx.accountB
                message.receiver = cli.account
            }
            if (!!idx.group) {
                if (!this.groupmessages.has(idx.group)) {
                    this.groupmessages.set(idx.group, new Array<Message>())
                }
                this.groupmessages.get(idx.group)?.push(message)
            } else {
                if (!this.usermessages.has(idx.accountB)) {
                    this.usermessages.set(idx.accountB, new Array<Message>())
                }
                this.usermessages.get(idx.accountB)?.push(message)
            }
        }
    }
    listGroup(): Array<string> {
        let arr = new Array<string>()
        this.groupmessages.forEach((_, key)=>{
            arr.push(key)
        })
        return arr
    }
    listUsers(): Array<string> {
        let arr = new Array<string>()
        this.usermessages.forEach((_, key)=>{
            arr.push(key)
        })
        return arr
    }
    getGroupMessagesCount(group: string): number {
        let messages =  this.groupmessages.get(group)
        if (!messages) {
             return 0
        }
        return messages.length
    }
    getUserMessagesCount(account: string): number {
        let messages = this.usermessages.get(account)
        if (!messages) {
            return 0
        }
        return messages.length
    }
    loadGroup(group: string, page: number): Promise<Message[]> {

    }

    private async lazload(messages: Array<Message>, page: number): Promise<Array<Message>> {
        let i = (page-1) * pageCount
        let msgs = messages.slice(i, i + pageCount)
        log.debug(msgs)
        if (!msgs || msgs.length === 0) {
            return new Array<Message>();
        }
        if (!!msgs[0].body) {
            return msgs
        }
        let { status, contents } = await this.loadcontent(msgs.map(idx=>idx.messageId))
        if (status != Status.Success) {
            return msgs
        }
        log.debug(`load context ${contents.map(c=>c.body)}`)
        if (contents.length == msgs.length) {
            for (let index= 0; index < msgs.length; index++) {
                let msg = msgs[index]
                let original = messages[i + index]
                let content = contents[index]
                Object.assign(msg, content)
                Object.assign(original, content)
            }
        }
        return msgs

    }
    private async loadcontent(messageIds: Long[]): Promise<{status: number, contents: MessageContent[]}> {
        let req = MessageContentReq.encode({messageIds})
        let pkt = LogicPkt.build(Command.OfflineContent, "", req.finish())
        let resp = await this.cli.request(pkt)
        if (resp.status != Status.Success) {
            let err = ErrorResp.decode(pkt.payload)
            log.error(err)
            return {status: resp.status, contents: new Array<MessageContent>()}
        }
        log.info(resp)
        let respbody = MessageContentResp.decode(resp.payload)
        return { status: resp.status, contents: respbody.contents }
    } 
}

export class Message {
    messageId: Long;
    type?: number
    body?: string
    extra?: string
    sender?: string
    receiver?: string    // 接收者
    group?: string
    sendTime: Long
    arrivalTime: number
    constructor(messageId: Long, sendTime: Long) {
        this.messageId = messageId
        this.sendTime = sendTime
        this.arrivalTime = Date.now()
    }
}


export class KIMClient{ 
    wsurl: string
    private req: LoginBody
    state = State.INIT
    channelId: string
    account: string
    private conn?: w3cwebsocket
    private lastRead: number
    private lastMessage?: Message
    private unack: number = 0
    private listeners = new Map<string, (e: KIMEvent) => void>()
    private messageCallback: (m: Message) => void
    private offmessageCallback: (m: OfflineMessages) => void
    private closeCallback?: () => void
    // 全双工请求队列
    private sendq = new Map<number, Request>()
    constructor(url:string, req: LoginBody) {
        this.wsurl = url
        this.req = req
        this.lastRead = Date.now()
        this.channelId = ""
        this.account = ""
        this.messageCallback = (m: Message) => {
            log.warn(`throw OfflineMessages.\nPlease check you had register a onofflinemessage callback method before login`)
        }
        this.offmessageCallback = (m: OfflineMessages) => {
            log.warn(`throw OfflineMessages.\nPlease check you had register a onofflinemessage callback method before login`)
        }
    }

}


