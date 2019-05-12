import {Provider} from './provider'
import {Driver} from './driver'

export class Shoal {
    constructor() {

    }

    broadcast(message?: object|string): void {
        console.log('broadcasting', message?message:'haha')
    }

    setProvider(providerSettings: object, providerClass: Provider): void {
        console.log(providerSettings, providerClass)
    }

    setDriver(driverSettings: object, driverClass: Driver): void {
        console.log(driverSettings, driverClass)
    }
}
