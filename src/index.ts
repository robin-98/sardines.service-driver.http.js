import * as querystring from 'querystring'
import * as request from 'isomorphic-fetch'
import * as utils from 'sardines-utils'
import { Http } from 'sardines-utils'


const Middlewares: any[] = []
const GroupProcesses: any[] = []
const PostProcesses: any[] = []
const ParallelProcesses: any[] = []



export class HttpServiceDriver {
    private providerInfo: Http.ServiceProviderPublicInfo

    constructor(providerInfo: Http.ServiceProviderPublicInfo) {
        this.providerInfo = providerInfo
    }

    private get logMesgHeader(): string {
        return '[HTTP Service Driver]'
    }

    static registerMiddleware(fn: any) {
        if (typeof fn === 'function') {
            Middlewares.push(fn)
        }
    }

    static registerGroupProcess(fn: any) {
        if (typeof fn === 'function') {
            GroupProcesses.push(fn)
        }
    }

    static registerPostProcess(fn: any) {
        if (typeof fn === 'function') {
            PostProcesses.push(fn)
        }
    }

    static registerParallelProcess(fn: any) {
        if (typeof fn === 'function') {
            ParallelProcesses.push(fn)
        }
    }

    // Invoke
    // return a promise
    invokeService(serviceSettings: Http.ServiceSettings, parameters: any[]) {
        let addr = this.assembleAddress(serviceSettings)
        const params = this.assembleParameters(serviceSettings, parameters)
        if (params.query) {
            addr += '?' + querystring.stringify(params.query)
            delete params.query
        }
        // CORS
        params.mode = 'cors'
        // Cookies for CORS
        params.credentials = 'include'

        const response: Http.ServiceResponse = Object.assign({}, {
            type: Http.ServiceResponseType.JSON,
        }, serviceSettings.response)

        if (ParallelProcesses.length > 0) {
            Promise.all(ParallelProcesses.map(fn => new Promise(async (resolve) =>{
                try {
                    const res = await fn({ service: serviceSettings, parameters, fetchOptions: params, address: addr })
                    return resolve(res)
                } catch (e) { 
                    utils.inspectedDebugLog(`${this.logMesgHeader} error when executing parallel process`, e)
                }
            })))
            .then(() => {
                // Ignore parallel processes
            })
            .catch(() => {
                // Ignore parallel processes
            })
        }

        return new Promise(async (resolve, reject) => {
            let errMsg: any = null
            utils.inspectedDebugLog(`${this.logMesgHeader} fetching address [${addr}] with parameters:`, params)

            // Execute the middlewares before the request
            const middlewareHandler = utils.chainFunctions(Middlewares, { service: serviceSettings, parameters, fetchOptions: params, address: addr })
            if (middlewareHandler) {
                try {
                    await middlewareHandler()
                } catch (e) {
                    // Middleware shall stop the process of the request
                    throw utils.unifyErrMesg(e, 'service driver', 'middleware')
                }
            }

            if (!addr || params.abort) {
                reject({type: 'service driver', subType: 'request aborted', error: 'request aborted by middleware'})
            }

            // Execute the request
            // Prepare the post processes before hand
            const execPostProcesses = async (error: any, result: any) => {
                const postProcessHandler = utils.chainFunctions(PostProcesses, {
                    service: serviceSettings,
                    parameters,
                    fetchOptions: params,
                    address: addr,
                    error,
                    result,
                })
                if (postProcessHandler) {
                    await postProcessHandler()
                }
            }

            // Group jobs are jobs must all succeed, otherwise fail as a whole
            const jobs = [
                request(addr, <RequestInit>params)
                .then((res: { status: number; statusText: any; json: () => void; text: () => void; formData: () => void; }) => {
                    if (res.status !== 200) {
                        errMsg = {
                            status: res.status,
                            message: res.statusText,
                        }
                    }
                    try {
                        let result = null
                        switch (response.type.toLocaleLowerCase()) {
                        case Http.ServiceResponseType.JSON:
                            result = res.json()
                            break
                        case Http.ServiceResponseType.text: case Http.ServiceResponseType.string:
                            result = res.text()
                            break
                        default:
                            result = res.formData()
                            break
                        }
                        return result
                    } catch (e) {
                        throw utils.unifyErrMesg(
                            { error: e, msg: `Error when parsing response content according to service response type: [${response.type}]` },
                            'service driver', 'parse result from response',
                        )
                    }
                }, (err: any) => {
                    throw utils.unifyErrMesg(err, 'servicde driver', 'request')
                })
                .then(async (payload: any) => {
                    let err = null
                    let result = null
                    if (!errMsg) {
                        if (typeof payload !== 'object') result = payload
                        if (payload.res) result = payload.res
                        else if (payload.error) {
                            err = payload
                        } else result = payload
                    } else {
                        err = Object.assign(errMsg, payload)
                    }
                    try {
                        await execPostProcesses(err, result)
                    } catch (e) {
                        err = utils.unifyErrMesg(e, 'service driver', 'post processes')
                    }
                    return {
                        err,
                        result,
                    }
                })
            ]
            Array.prototype.push.apply(jobs, GroupProcesses.map(fn => new Promise(async (resolve, reject)=> {
                try {
                    const res = await fn({ service: serviceSettings, parameters, fetchOptions: params, address: addr })
                    resolve(res)
                } catch (e) {
                    reject(e)
                }
            })))
            Promise.all(jobs)
            .then(responses => {
                const res = responses[0]
                if (res.err) {
                    if (res.err.type === 'service provider' && res.err.subType === 'service handler') {
                        reject(res.err.error)
                    } else reject(res.err)
                } else resolve(res.result)
            })
            .catch(e => {
                if(e && typeof e === 'object' && typeof e.error !== 'undefined' && typeof e.type === 'string') {
                    reject(e)
                } else {
                    reject(utils.unifyErrMesg(e, 'service driver', 'group process'))
                }
            })

            
        })
    }

    // Assemble address
    assembleAddress(serviceSettings: Http.ServiceSettings) {
        let addr = this.providerInfo.host || '127.0.0.1'
        if (this.providerInfo.port) {
            addr += `:${this.providerInfo.port}`
        }
        if (this.providerInfo.root) {
            addr += this.providerInfo.root
        }
        addr += serviceSettings.path
        addr = addr.replace(/\/+/, '/')
        addr = (this.providerInfo.protocol || 'http') + '://' + addr
        return addr
    }

    // Assemble parameters
    assembleParameters(service: Http.ServiceSettings, parameters: any[]) {
        let params: {method?: string; headers?: any; body?: any; query?: any; mode?: string; credentials?: RequestCredentials; abort?: boolean} = {},
        // let params: RequestInit = {},
            headers: {'Content-Type'?: string; cookie?: string; [key: string]: any} = { 
                'Content-Type': 'application/json',
            }, 
            query: any = null,
            body: any = null,
            cookie: any = null
        const schema: Http.ServiceInputParameter[] = service.inputParameters || []
        params.method = (service.method || 'POST').toUpperCase()
        if (Object.prototype.toString.call(schema) === '[object Array]') {
            parameters.forEach((item, i) => {
                if (item !== null && schema.length > i) {
                    const def: Http.ServiceInputParameter = schema[i]
                    switch (def.position.toLocaleString()) {
                    case 'body':
                        if (!def.name && typeof item === 'object') {
                            body = item
                        } else if (def.name) {
                            if (body === null) body = {}
                            body[def.name] = item
                        }
                        break
                    case 'header': case 'headers':
                        if (!def.name && typeof item === 'object') {
                            headers = item
                        } else if (def.name) {
                            if (headers === null) headers = {}
                            headers[def.name] = item
                        }
                        break
                    case 'query': case 'address': case 'addr':
                        if (!def.name && typeof item === 'object') {
                            query = item
                        } else if (def.name) {
                            if (query === null) query = {}
                            query[def.name] = item
                        }
                        break
                    case 'cookie': case 'cookies':
                        if (!def.name && typeof item === 'object') {
                            cookie = item
                        } else if (def.name) {
                            if (cookie=== null) cookie = {}
                            cookie[def.name] = item
                        }
                        break
                    default:
                        break
                    }
                }
            })
        }
        if (cookie) {
            for (let c in cookie) {
                const cstr = c + '=' + cookie[c] + ' '
                headers.cookie = headers.cookie ? headers.cookie + cstr : cstr 
            }
        }
        params.headers = new Headers(headers)
        if (body) {
            params.body = JSON.stringify(body)
        }
        if (query) params.query = query

        return params
    }
}
