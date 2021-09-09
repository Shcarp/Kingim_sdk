import { Header, Flag, Status } from "./proto/common";

// 获取0-65535之间的整数
export class Seq {
    static num : number = 0
    static Next() {
        Seq.num++
        Seq.num = Seq.num % 65536
        return Seq.num
    }
}

export enum Command {
     // login
     SignIn = "login.signin",
     SignOut = "login.signout",
 
     // chat
     ChatUserTalk = "chat.user.talk",
     ChatGroupTalk = "chat.group.talk",
     ChatTalkAck = "chat.talk.ack",
 
     // 离线
     OfflineIndex = "chat.offline.index",
     OfflineContent = "chat.offline.content",
 
     // 群管理
     GroupCreate = "chat.group.create",
     GroupJoin = "chat.group.join",
     GroupQuit = "chat.group.quit",
     GroupDetail = "chat.group.detail",
}

// 魔数
const MagicLogicPkt  = new Uint8Array([0xc3, 0x11, 0xa3, 0x65])
const MagicBasicPkt  = new Uint8Array([0xc3, 0x15, 0xa7, 0x65])

export const MagicLogicPktInt = Buffer.from(MagicLogicPkt).readInt32BE()
export const MagicBasicPktInt = Buffer.from(MagicBasicPkt).readInt32BE()

// 信息类型
export enum MessageType {
    Text = 1,  // 文字
    Image = 2,  // 图片
    Voice = 3,  // 语音
    Video = 4,  // 视频
}
// ping and pong

export const Ping = new Uint8Array([0xc3, 0x15, 0xa7, 0x65, 0, 1, 0, 0])
export const Pong = new Uint8Array([0xc3, 0x15, 0xa7, 0x65, 0, 2, 0, 0])

export class LogicPkt {
    command ?: string
    channelId ?: string
    sequence: number = 0
    flag ?: number
    status : number = Status.Success
    dest ?: string
    payload: Uint8Array
    constructor() {
        this.payload = new Uint8Array();
    }
    static build(command:string, dest: string, payload: Uint8Array=new Uint8Array()): LogicPkt {
         // build LogicPkt
         let message = new LogicPkt()
         message.command = command
         message.sequence = Seq.Next()
         message.dest = dest
         if (payload.length > 0) {
             message.payload = payload
         }
         return message
    }
    // 类型为 魔数+头长度+头+内容长度+内容
    static from (buf: Buffer): LogicPkt {
        let offset = 0
        let magic = buf.readInt32BE(offset)
        let hlen = 0
        // 判断前面四个字节是否为Magic
        if (magic == MagicLogicPktInt) {
            offset += 4
        }
        hlen = buf.readInt32BE(offset)
        offset += 4
        // 反序列化Header
        let header = Header.decode(buf.subarray(offset, offset + hlen))
        offset += hlen
        let message = new LogicPkt()
        // 把header中的属性copy到message
        Object.assign(message, header)
        // 读取payload
        let plen = buf.readInt32BE(offset)
        offset += 4
        message.payload = buf.subarray(offset, offset + plen)
        return message     
    }
    bytes(): Buffer {
        let headerArray = Header.encode(Header.fromJSON(this)).finish()
        let hlen = headerArray.length
        let plen = this.payload.length
        let buf = Buffer.alloc(4+4+hlen+4+plen)
        let offset = 0
        Buffer.from(MagicLogicPkt).copy(buf, offset, 0)
        offset += 4
        offset =  buf.writeInt32BE(hlen, offset)
        Buffer.from(headerArray).copy(buf, offset, 0)    
        offset += hlen
        offset = buf.writeInt32BE(plen, offset)
        Buffer.from(this.payload).copy(buf, offset, 0)
        return buf
    }
}
export let print = (err: Uint8Array) => {
    if (err == null) {
        return
    }
    console.info(`[${err.join(",")}]`)
}


