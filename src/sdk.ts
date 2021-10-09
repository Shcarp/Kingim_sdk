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
import { SCOPABLE_TYPES, throwStatement, tsConstructorType } from "@babel/types";

// 心跳检测
const heartbeatInterval = 55 * 1000
// 发送时间
const sendTimeout = 5 * 1000

enum TimeUnit {
    Second = 1000,
    Millisecond = 1
}

export let sleep = async (second: number, Unit: TimeUnit = TimeUnit.Second): Promise<void> =>{
    return new Promise((resolve, reject) => {
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

// 响应
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

// 请求
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
    async loadGroup(group: string, page: number): Promise<Message[]> {
        let messages = this.groupmessages.get(group)
        if (!messages) {
            return new Array<Message>()
        }
        let msgs = await this.lazyLoad(messages, page)
        return msgs
    }

    async loadUser(account: string, page: number): Promise<Message[]> {
        let messages = this.usermessages.get(account)
        if (!messages) {
            return new Array<Message>()
        }
        let msgs = await this.lazyLoad(messages, page)
        return msgs
    }

    private async lazyLoad(messages: Array<Message>, page: number): Promise<Array<Message>> {
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

export class Content {
    type?: number
    body: string
    extra?: string
    constructor(body: string, type: number = MessageType.Text, extra?: string) {
        this.type = type
        this.body = body
        this.extra = extra
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
    // 全双工请求队列， 用来保存请求
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
    // 把事件注册到Client中
    register(events: string[], callback: (e: KIMEvent)=>void) {
        events.forEach((event) =>{
            this.listeners.set(event, callback)
        })
    }
    onmessage(cb: (m: Message)=>void) {
        this.messageCallback = cb
    }
    onofflinemessage(cb: (m: OfflineMessages) => void) {
        this.offmessageCallback = cb
    }
    // 登录
    async login(): Promise<{success: boolean ,err?: Error}> {
        if (this.state === State.CONNECTING) {
            return { success: false, err: new Error("client has already been connected") }
        }
        this.state = State.CONNECTING
        let { success, err, channelId, account, conn } = await doLogin(this.wsurl, this.req)
        if (!success) {
            this.state = State.INIT
            return { success, err }
        }
        log.info("login -", success)

        conn.onmessage = (evt: IMessageEvent) =>{
            try {
                // 信息的最后查看时间
                this.lastRead = Date.now()
                let buf:Buffer = Buffer.from(<ArrayBuffer>evt.data)
                let magic = buf.readInt32BE()
                if (magic === MagicBasicPktInt) {
                    log.debug(`recv a basic packet - ${buf.join(",")}`)
                    return
                }
                let pkt = LogicPkt.from(buf)
                this.packetHandler(pkt)
            } catch (error) {
                log.error(evt.data, error)
            }
        }
        conn.onerror = (error) =>{
            log.info("websocket error: ", error)
            this.errorHandler(error)
        }
        conn.onclose = (e: ICloseEvent) =>{
            log.debug("event[onclose] fired")
            if (this.state == State.CLOSEING) {
                this.onclose("logout")
                return
            }
            this.errorHandler(new Error(e.reason))
        }
        this.conn = conn
        this.channelId = channelId || ""
        this.account = account || ""
        await this.loadOfflineMessage()  // 离线信息
        this.state = State.CONNECTED
        this.heartbeatLoop()
        this.readDeadlineLoop()
        this.messageAckLoop()
        return { success, err }

    }
    logout(): Promise<void> {
        return new Promise((resolve, _) => {
            if (this.state == State.CLOSED) {
                return
            }
            this.state = State.CLOSEING // 正在关闭
            if (!this.conn) {
                return
            }
            let tr = setTimeout(()=>{
                log.debug("oh no,logout is timeout~")
                this.onclose("logout")
                resolve()
            }, 1500)
            // 设置closeCallback 处理函数
            this.closeCallback = async ()=>{
                clearTimeout(tr)
                await sleep(1)
                resolve()
            }
            this.conn.close()
            log.info("Connection closing...")
        })
    }
    /**
     * 给用户发送一条信息
     * @param dest 目标
     * @param req 信息体
     * @param retry 重试次数
     * @returns 
     */
    async talkToUser(dest: string, req: Content, retry: number = 3): Promise<{ status: number, resp?: MessageResp, err?: ErrorResp }> {
        return this.talk(Command.ChatUserTalk, dest, MessageReq.fromJSON(req), retry)
    }

    /**
     * 给群发送一条信息
     * @param dest 群id
     * @param req 信息
     * @param retry 重试次数
     * @returns 
     */
    async talkToGroup(dest: string, req: Content, retry: number = 3): Promise<{ status: number, resp?: MessageResp, err?: ErrorResp }> {
        return this.talk(Command.ChatGroupTalk, dest, MessageReq.fromJSON(req), retry)
    }

    /**
     * 创建群
     * @param req 
     * @returns 
     */
    async createGroup(req: {
        name: string;
        avatar: string;
        introduction?: string
        members: string[]
    }): Promise<{ status: number, resp?: GroupCreateResp, err?: ErrorResp}> {
        let req2 = GroupCreateReq.fromJSON(req)
        req2.owner = this.account
        if (!req2.members.find(v=>v == this.account)) {
            req2.members.push(this.account)
        }
        let pbrep = GroupCreateReq.encode(req2).finish()
        let pkt = LogicPkt.build(Command.GroupCreate, "", pbrep)
        let resp = await this.request(pkt)
        if(resp.status != Status.Success) {
            let err = ErrorResp.decode(resp.payload)
            return { status: resp.status, err: err }
        }
        return { status: Status.Success, resp: GroupCreateResp.decode(resp.payload) }
    }

    async joinGroup(req: GroupJoinReq): Promise<{ status: number, err?: ErrorResp }> {
        let pbreq = GroupJoinReq.encode(req).finish()
        let pkt = LogicPkt.build(Command.GroupJoin, "", pbreq)
        let resp = await this.request(pkt)
        if (resp.status != Status.Success) {
            let err = ErrorResp.decode(resp.payload)
            return { status: resp.status, err: err }
        }

        return { status: Status.Success }
    }

    async quitGroup(req: GroupQuitReq): Promise<{ status: number, err?: ErrorResp }> {
        let pbreq = GroupQuitReq.encode(req).finish()
        let pkt = LogicPkt.build(Command.GroupQuit, "", pbreq)
        let resp = await this.request(pkt)
        if (resp.status != Status.Success) {
            let err = ErrorResp.decode(resp.payload)
            return { status: resp.status, err: err }
        }
        return { status: Status.Success } 
    }

    async GetGroup(req: GroupGetReq): Promise<{ status: number, resp?: GroupGetResp, err?: ErrorResp }> {
        let pbreq = GroupGetReq.encode(req).finish()
        let pkt = LogicPkt.build(Command.GroupDetail, "", pbreq)
        let resp = await this.request(pkt)
        if (resp.status != Status.Success) {
            let err = ErrorResp.decode(resp.payload)
            return { status: resp.status, err: err }
        }
        return { status: Status.Success, resp: GroupGetResp.decode(resp.payload) }
    }

    /**
     * 发送信息
     * @param command 指令
     * @param dest 目标
     * @param req 信息体
     * @param retry 重试次数
     * @returns 
     */
    async talk(command: Command, dest: string, req: MessageReq, retry: number):  Promise<{ status: number, resp?: MessageResp, err?: ErrorResp }> {
        let pbreq = MessageReq.encode(req).finish()
        for (let index = 0; index < retry+1; index++) {
            let pkt = LogicPkt.build(command, dest, pbreq)
            let resp = await this.request(pkt)
            if (resp.status == Status.Success) {
                return { status: Status.Success, resp: MessageResp.decode(resp.payload)}
            }
            if (resp.status >= 300 && resp.status <= 400) {
                log.warn("retry to send message")
                continue
            }
            let err = ErrorResp.decode(resp.payload)
            return { status: resp.status, err: err }
        }
        return { status: KIMStatus.SendFailed, err: new Error("over max retry times") }
    }

    
    async request(data: LogicPkt): Promise<Response> {
        return new Promise((resolve, _) => {
            let seq = data.sequence
            // 超时删除请求队列中的请求
            let tr = setTimeout(()=>{
                this.sendq.delete(seq)
                resolve(new Response(KIMStatus.RequestTimeout))   // 返回一个超时的响应
            }, sendTimeout)

            // 异步等待响应
            let callback = (pkt: LogicPkt) =>{
                clearTimeout(tr)
                this.sendq.delete(seq)
                resolve(new Response(pkt.status, pkt.dest, pkt.payload))
            }
            log.debug(`request seq:${seq} command:${data.command}`)
            this.sendq.set(seq, new Request(data, callback))
            // 发送
            if(!this.send(data.bytes())) {
                resolve(new Response(KIMStatus.SendFailed)) 
            }
        })
    }

    private fireEvent(event: KIMEvent) {
        let listener = this.listeners.get(event)
        if (!!listener) {
            listener(event)
        }
    }

    // 信息处理入口
    private async packetHandler(pkt: LogicPkt) {
        log.debug("received packet: ", pkt)
        if (pkt.status >= 400) {
            log.info(`need relogin due to status ${pkt.status}`)
            this.conn?.close()
            return
        }
        // 如果返回是来自服务器的回应，则在全双工队列查找
        if (pkt.flag == Flag.Response) {
            let req = this.sendq.get(pkt.sequence)
            if (req) { // 通过请求里面的回调函数将结果返回
                req.callback(pkt)
            } else {
                log.error(`req of ${pkt.sequence} no found in sendq`)
            }
            return
        }
        switch (pkt.command) {
            case Command.ChatUserTalk :
            case Command.ChatGroupTalk:
                let push = MessagePush.decode(pkt.payload)
                let message = new Message(push.messageId, push.sendTime)
                Object.assign(message, push)
                message.receiver = this.account
                if (pkt.command == Command.ChatGroupTalk) {
                    message.group = pkt.dest
                }
                if (!await Store.exist(message.messageId)) {
                    if (this.state === State.CONNECTED) {
                        this.lastMessage = message  // 标记最后一条信息
                        this.unack++
                        try {
                            this.messageCallback(message) // 将信息回调给上层
                        } catch (error) {
                            log.error(error)
                        }
                    }
                    await Store.insert(message)  // 信息保存在数据库中
                }
                break
            case Command.SignIn: 
                let ko = KickoutNotify.decode(pkt.payload)
                if (ko.channelId == this.channelId) {
                    this.logout()
                    this.fireEvent(KIMEvent.Kickout)   // 在listens中调用 // 被踢下线
                }
                break
        }
    }
    // 心跳检测,
    private heartbeatLoop () {
        log.debug("heartbeatLoop start")
        let start = Date.now()
        let loop = () =>{
            if (this.state != State.CONNECTED) {
                log.debug("heartbeatLoop exited")
                return
            }
            if (Date.now()-start >= heartbeatInterval) {
                log.debug(`>>> send ping ; state is ${this.state}`)
                start = Date.now()
                this.send(Ping)
            }
            setTimeout(loop, 500)
        }
        setTimeout(loop, 500)
    }
    // 读超时
    private readDeadlineLoop() {
        log.debug("deadlineLoop start")
        let loop = () =>{
            if (this.state != State.CONNECTED) {
                log.debug("deadlineLoop exited")
                return
            }
            if (Date.now()-this.lastRead > 3 * heartbeatInterval) {
                // 如果最后一次的时间差超过 一定的时间 则调用errHandler 处理
                this.errorHandler(new Error("read timeout"))
            }
            setTimeout(loop, 500)
        }
        setTimeout(loop, 500)
    }

    private messageAckLoop() {
        let start = Date.now()
        const delay = 500
        let loop = async () => {
            if (this.state != State.CONNECTED) {
                log.debug("messageAckLoop exited")
                return
            }
            let msg = this.lastMessage
            if (!!msg && (Date.now()-start > 3000)) {
                let overflow = this.unack > 10
                this.unack = 0
                this.lastMessage = undefined
                let diff = Date.now() - msg.arrivalTime
                if (!overflow && diff < delay) {
                    await sleep(delay - delay, TimeUnit.Millisecond)
                } 
                let req = MessageAckReq.encode({messageId: msg.messageId})
                let pkt = LogicPkt.build(Command.ChatTalkAck, "", req.finish())
                start = Date.now()
                this.send(pkt.bytes())
                await Store.setAck(msg.messageId)
            }
            setTimeout(loop, 500)
        }
        setTimeout(loop, 500)
    }

    // 加载离线信息
    private async loadOfflineMessage() {
        log.debug("loadOfflineMessage start")
        // 加载信息索引
        let loadIndex = async (messageId: Long = Long.ZERO): Promise<{status: number, indexes?: MessageIndex[]}> => {
            let req = MessageIndexReq.encode({messageId})
            let pkt = LogicPkt.build(Command.OfflineIndex, "", req.finish())
            let resp = await this.request(pkt)
            if (resp.status != Status.Success) {
                let err = ErrorResp.decode(pkt.payload)
                log.error(err)
                return {status: resp.status}
            }
            let respbody = MessageIndexResp.decode(resp.payload)
            return {status: resp.status, indexes: respbody.indexes}
        }
        let offmessages = new Array<MessageIndex> ()
        let messageId = await Store.lastId()
        // 获取信息索引
        while (true) {
            let { status, indexes } = await loadIndex(messageId)
            if (status != Status.Success) {
                break
            }
            if ( !indexes || indexes.length) {
                break
            }
            messageId = indexes[indexes.length-1].messageId
            offmessages = offmessages.concat(indexes)
        }
        log.info(`load offline indexes - ${offmessages.map(msg => msg.messageId.toString())}`)
        let om = new OfflineMessages(this, offmessages)
        this.offmessageCallback(om)   // 把获取离线信息的对象通过回掉返回

    }

    // 表示连接终止
    private onclose(reason: string) {
        if (this.state == State.CLOSED) {
            return
        }
        this.state = State.CLOSED
        log.info("connection closed due to " + reason)
        this.conn = undefined
        this.channelId = ""
        this.account = ""
        this.fireEvent(KIMEvent.Closed)
        if (this.closeCallback) {
            this.closeCallback()
        }
    }

    // 自动重连
    private async errorHandler(error: Error) {
        // 如果是主动断开，就不进行自动重连
        // 比如被踢或者是主动调用logout()方法
        if (this.state == State.CLOSED || this.state == State.CLOSEING) {
            return
        }
        this.state = State.RECONNECTING
        this.fireEvent(KIMEvent.Reconnecting)
        for (let index = 0; index < 10; index ++) {
            await sleep(3)
            try {
                log.info("try to relogin")
                let { success, err } = await this.login()
                if (success) {
                    this.fireEvent(KIMEvent.Reconnected)
                    return
                }
                log.info(err)
            } catch (error) {
                log.warn(error)
            }
        }
        this.onclose("reconnect timeout")
    }
    private send(data: Buffer | Uint8Array): boolean {
        try {
            if (this.conn == null) {
                return false
            }
            this.conn.send(data)
        } catch (error) {
            this.errorHandler(new Error("write timeout"))
            return false
        }
        return true
    }
}


class MsgStorage {
    constructor() {
        localforage.config({
            name: 'kim',
            storeName: 'kim',
        })
    }
    // 键处理
    private keymsg(id: Long): string {
        return `msg_${id.toString()}`
    }
    private keylast(): string {
        return `last_id`
    }
    // 记录一条信息
    async insert(msg: Message): Promise<boolean> {
        await localforage.setItem(this.keymsg(msg.messageId), msg)
        return true
    }
    // 检查信息是否已经保存
    async exist(id: Long): Promise<boolean> {
        try {
            let val = await localforage.getItem(this.keymsg(id))
            return !!val
        } catch (err) {
            log.warn(err)
        }
        return false
    }
    // 获取信息
    async get(id: Long): Promise<Message| null> {
        try {
            let val = await localforage.getItem(this.keymsg(id))
            return <Message>val
        } catch (error) {
            log.warn(error)
        }
        return null
    }
    async setAck(id: Long): Promise<boolean> {
        await localforage.setItem(this.keylast(), id)
        return true
    }
    async lastId(): Promise<Long> {
        let id = await localforage.getItem(this.keylast())
        return <Long>id || Long.ZERO
    }
}
export const Store = new MsgStorage()

