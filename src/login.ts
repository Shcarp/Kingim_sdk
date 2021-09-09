import { w3cwebsocket } from "websocket";
import { Buffer } from "buffer";
import log from "loglevel-es"
import { Command, LogicPkt } from "./packet";
import { Status } from "./proto/common";
import { LoginReq, LoginResp } from "./proto/protocol";

export interface LoginResult {
    success: boolean
    err?: Error
    channelId?: string
    account?: string
    conn: w3cwebsocket
}

const loginTimeout = 10 *1000

export class LoginBody {
    token: string;
    tags?: string[];
    constructor(token: string, tags?: string[]){
        this.tags = tags
        this.token = token
    }
}

export let doLogin = async (url: string, req: LoginBody): Promise<LoginResult> =>{
    return new Promise((resolve, reject)=>{
        let conn = new w3cwebsocket(url)
        conn.binaryType = "arraybuffer"
        // 设置登录超时器
        let tr = setTimeout(()=>{
            clearTimeout(tr)
            resolve({success: false, err: new Error("timeout"), conn: conn})
        }, loginTimeout);
        
        conn.onopen = () => {
            log.info(`connection established, send ${req.token}`)
            let logicpkt = LoginReq.encode(LoginReq.fromJSON(req)).finish()
            let resqpkt = LogicPkt.build(Command.SignIn, "", logicpkt)
            let buf = resqpkt.bytes()
            conn.send(buf)
        }
        conn.onerror = (error: Error) => {
            clearTimeout(tr)
            log.warn(error)
            resolve({success: false, err: error, conn: conn})
        }
        conn.onmessage = (event) => {
            if (typeof event.data === "string") {
                log.warn("Received: '" + event.data + "'")  
                return              
            }
            clearTimeout(tr)
            let buf = Buffer.from(event.data)
            let loginResp = LogicPkt.from(buf)
            if (loginResp.status === Status.Success) {
                log.error("Login failed: " + loginResp.status)
                resolve({ success: false, err: new Error(`response status is ${loginResp.status}`), conn: conn });
                return
            }
            let resp = LoginResp.decode(loginResp.payload)
            resolve({
                success: true,
                account: resp.account,
                channelId: resp.channelId,
                conn
            })

        }
    })
}