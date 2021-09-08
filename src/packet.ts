import { Header, Flag, Status } from "./proto/common";
import log from "loglevel-es";
import { LoginReq } from "./proto/protocol";

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
    // 登陆
    SingIn =  "login.signin",
    SingOut = "login.singout",
    // 聊天
    ChatUserTalk = "chat.user.talk",
    ChatGroupTalk = "chat.group.talk",
    ChatTalkAck = "chat.talk.ack",
    // 离线
    OfflineIndex = "chat.offline.talk",
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
    status ?: number = Status.Success
    dest ?: string
    payload: Uint8Array
    constructor() {
        this.payload = new Uint8Array();
    }
    static build()
}


