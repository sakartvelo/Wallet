import { observable, action, computed } from 'mobx';
import { asyncAction } from 'mobx-utils';
import * as sortBy from 'lodash/fp/sortBy';
import {
    Api,
    IAccountInfo,
    ICurrencyInfo,
    IValidation,
} from 'app/api';
import * as BigNumber from 'bignumber.js';
import { ICurrencyItemProps } from 'app/components/common/currency-big-select';
import { IAccountItemProps } from 'app/components/common/account-item';

const sortByName = sortBy(['name', 'address']);
const UPDATE_INTERVAL = 5000;
const MAX_VISIBLE_ERRORS = 5;

export interface IHasAddress {
    address: string;
}

export interface IAddressMap<T extends IHasAddress> {
    [address: string]: T;
}

export interface ISendFormValues {
    amount: string;
    gasPrice: string;
    gasLimit: string;
    toAddress: string;
}

export interface ISendValidation extends IValidation {
    password: string;
}

export interface IPasswordCache {
    [address: string]: string;
}

export type TGasPricePriority = 'low' | 'normal' | 'high';

export class MainStore {
    public static ADDRESS_ETHER = '0x';
    public static DEFAULT_GAS_LIMIT = '50000';

    protected sonmTokenAddress: string = '';

    @observable public averageGasPrice = '';

    @observable public notification = [];

    @observable public accountMap = new Map<string, IAccountInfo>();

    @observable public currencyMap =  new Map<string, ICurrencyInfo>();

    @observable private userSelectedAccountAddress = '';

    @observable public userSelectedCurrencyAddress = '';

    @observable public userGasPrice = '';

    @observable public errors: any[] = [];

    @observable public validation: IValidation = {};

    public values: ISendFormValues = {
        toAddress: '',
        amount: '',
        gasPrice: '',
        gasLimit: '',
    };

    @computed get lastErrors(): any[] {
        const len = this.errors.length;
        if (len === 0) {
            return [];
        }

        return this.errors.slice(len - MAX_VISIBLE_ERRORS);
    }

    @computed public get priority(): TGasPricePriority {
        let result: TGasPricePriority = 'normal';

        if (this.userGasPrice !== '') {
            const [ min, max ] = this.gasPriceThresholds;
            const userInput = new BigNumber(this.userGasPrice);
            if (userInput.lessThanOrEqualTo(min)) {
                result = 'low';
            } else if (userInput.greaterThanOrEqualTo(max)) {
                result = 'high';
            }
        }

        return result;
    }

    @computed public get gasPriceThresholds(): [string, string] {
        let min = '5000';
        let max = '15000';

        if (this.averageGasPrice !== '') {
            const bn = new BigNumber(this.averageGasPrice);

            min = bn.mul(0.5).toFixed(18);
            max = bn.mul(1.5).toFixed(18);
        }

        return [min, max];
    }

    public static findCurrencyBySymbol(map: Map<string, ICurrencyInfo>, symbol: string) {
        let result;

        if (map.size === 0) {
            return '';
        }

        const s = symbol.toUpperCase();

        map.forEach(
            (value, key) => {
                if (value.symbol.toUpperCase() === s) {
                    result = value.address;
                }
            },
        );

        if (result === undefined) { throw new Error(`token ${symbol} address  not found`); }

        return result;
    }

    public get firstTokenAddress(): string {
        return MainStore.ADDRESS_ETHER;
    }

    private secondTokenAddressProp = '';

    public get secondTokenAddress(): string {
        return this.secondTokenAddressProp;
    }

    @computed public get firstToken(): ICurrencyInfo {
        const result = this.currencyMap.get(this.firstTokenAddress);

        if (!result) { throw new Error(`First token ${this.firstTokenAddress} not found`); }

        return result;
    }

    @computed public get secondToken(): ICurrencyInfo {
        const result = this.currencyMap.get(this.secondTokenAddress);

        if (!result) { throw new Error(`Second token ${this.secondTokenAddress} not found`); }

        return result;
    }

    @computed public get firstTokenBalance(): string {
        return MainStore.getTokenBalance(this.fullBalanceList, this.firstTokenAddress);
    }

    @computed public get secondTokenBalance(): string {
        return MainStore.getTokenBalance(this.fullBalanceList, this.secondTokenAddress);
    }

    private static getTokenBalance(fullList: ICurrencyItemProps[], address: string) {
        const f = fullList.find(x => x.address === address);

        return f ? `${f.balance} ${f.symbol}` : `Token ${address} not found`;
    }

    @computed public get accountList(): IAccountItemProps[] {
        if (this.accountMap === undefined || this.currencyMap === undefined) {
            return [];
        }

        const firstTokenAddress = this.firstTokenAddress;
        const secondTokenAddress = this.secondTokenAddress;

        const result = Array.from(this.accountMap.values()).map(account => {
            const props: IAccountItemProps = {
                address: account.address,
                name: account.name,
                firstBalance: `${account.currencyBalanceMap[firstTokenAddress]} ${this.firstToken.symbol}`,
                secondBalance: `${account.currencyBalanceMap[secondTokenAddress]} ${this.secondToken.symbol}`,
            };

            return props;
        });

        return sortByName(result) as IAccountItemProps[];
    }

    private getBalanceListFor(...accounts: string[]): ICurrencyItemProps[] {
        if (this.accountMap === undefined || this.currencyMap === undefined) {
            return [];
        }

        const result = Array.from(this.currencyMap.values()).map((currency): ICurrencyItemProps => {
            return {
                name: currency.name,
                symbol: currency.symbol,
                decimals: currency.decimals,
                balance: accounts.reduce((sum: any, accountAddr: string) => {
                    const account = this.accountMap.get(accountAddr);

                    if (account) {
                        sum = sum.plus(account.currencyBalanceMap[currency.address]);
                    }

                    return sum;
                }, new BigNumber(0)).toFixed(currency.decimals),
                address: currency.address,
            };
        });

        return result;
    }

    @computed public get fullBalanceList(): ICurrencyItemProps[]  {
        const allAccounts = Array.from(this.accountMap.keys());

        return this.getBalanceListFor(...allAccounts);
    }

    @computed public get currentBalanceList(): ICurrencyItemProps[] {
        if (this.selectedAccountAddress === '') {
            return [];
        }

        return this.getBalanceListFor(this.selectedAccountAddress);
    }

    @action.bound
    public setUserGasPrice(value: string): void  {
        try {
            const bn = new BigNumber(value);
            this.userGasPrice = bn.toString();
        } catch (e) {
            this.handleError(e);
        }
    }

    @asyncAction
    public *deleteAccount(deleteAddress: string) {
        try {
            const { data: success } = yield Api.removeAccount(deleteAddress);

            if (success) {
                this.accountMap.delete(deleteAddress);
            }
        } catch (e) {
            this.handleError(e);
        }
    }

    @action.bound
    public decreaseBalance(accountAddress: string, currencyAddress: string, amount: string) {
        const account = this.accountMap.get(accountAddress) as IAccountInfo;
        if (account === undefined) { throw new Error(`Unknown accountAddress ${accountAddress}`); }

        const balance = account.currencyBalanceMap[currencyAddress];
        if (balance === undefined) { throw new Error(`Unknown accountAddress ${accountAddress}`); }

        account.currencyBalanceMap[currencyAddress] = new BigNumber(balance).minus(amount).toString();
    }

    @action.bound
    public selectAccount(accountAddr: string) {
        if (accountAddr !== this.userSelectedAccountAddress) {
            this.userSelectedAccountAddress = accountAddr;
        }
    }

    @action.bound
    public selectCurrency(currencyAddr: string) {
        this.userSelectedCurrencyAddress = currencyAddr;
    }

    @computed public get selectedAccountAddress(): string {
        const addr = this.userSelectedAccountAddress;

        return this.accountMap.has(addr)
            ? addr
            : (this.accountMap.size > 0)
                ? this.accountMap.keys().next().value
                : '';

    }

    @computed public get selectedCurrencyAddress(): string {
        const addr = this.userSelectedCurrencyAddress;

        return this.currencyMap.has(addr)
            ? addr
            : (this.currencyMap.size > 0)
                ? this.currencyMap.keys().next().value
                : '';

    }

    @action.bound
    public setSendParams(values: ISendFormValues) {
        this.values = values;
    }

    @asyncAction
    public *renameAccount(address: string, name: string) {
        try {
            const success = yield Api.renameAccount(address, name);

            if (success) {
                (this.accountMap.get(address) as IAccountInfo).name = name;
            }
        } catch (e) {
            this.handleError(e);
        }
    }

    protected passwordCache: IPasswordCache = {};

    @asyncAction
    public *checkSelectedAccountPassword(password: string) {
        const accountAddress = this.selectedAccountAddress;

        let validationMessage = '';

        if (accountAddress in this.passwordCache
                && this.passwordCache[accountAddress] === password) {
            validationMessage = '';
        } else {
            const {data: success, validation} = yield Api.checkPrivateKey(password, accountAddress);

            if (success) {
                this.passwordCache[accountAddress] = password;
                validationMessage = '';
            } else if (validation && validation.password) {
                validationMessage = validation.password;
            }
        }

        const isValid = validationMessage === '';

        if (!isValid) {
            this.validation = { password: validationMessage };
        }

        return isValid;
    }

    @asyncAction
    public *confirmTransaction(password: string) {
        try {
            const tx = {
                toAddress: this.values.toAddress,
                amount: this.values.amount,
                fromAddress: this.selectedAccountAddress,
                currencyAddress: this.selectedCurrencyAddress,
                gasPrice: this.values.gasPrice,
                gasLimit: this.values.gasLimit,
                timestamp: Date.now(),
            };

            this.values.toAddress = '';
            this.values.amount = '';

            const result = yield Api.send(tx, password);

            window.alert(JSON.stringify(result));

            return result;
        } catch (e) {
            this.handleError(e);
        }
    }

    @asyncAction
    public *init() {
        const pendingId = this.startPending('init');

        try {
            this.secondTokenAddressProp = (yield Api.getSonmTokenAddress()).data;

            const [{data: currencyList}] = yield Promise.all([
                Api.getCurrencyList(),
                this.startAutoUpdate(UPDATE_INTERVAL), // wait for first update
            ]);

            listToMap<ICurrencyInfo>(currencyList, this.currencyMap);

            this.userGasPrice = this.averageGasPrice;
        } catch (e) {
            this.handleError(e);
        } finally {

            this.stopPending(pendingId);
        }
    }

    @action
    private update(result: any) {
        const [
            { data: averageGasPrice },
            { data: accountList },
        ] = result;

        this.averageGasPrice = averageGasPrice;
        listToMap<IAccountInfo>(accountList, this.accountMap);
    }

    public startAutoUpdate(interval: number) {
        const iteration = async () => {
            try {
                window.console.time('update')

                const result = await Promise.all([
                    Api.getGasPrice(),
                    Api.getAccountList(),
                ]);

                this.update(result);
            } catch (e) {
                this.handleError(e);
            } finally {
                window.console.timeEnd('update');
                setTimeout(iteration, interval);
            }
        };

        return iteration();
    }

    @asyncAction
    public *addAccount(json: string, password: string, name: string) {
        let result: IValidation | undefined;

        try {

            const {data, validation} = yield Api.addAccount(json, password, name);

            if (validation) {
                result = validation;
                this.validation = validation;
            } else {
                this.accountMap.set(data.address, data);
            }

        } catch (e) {
            this.handleError(e);
        }

        return result;
    }

    public getMaxValue(gasPrice: string, gasLimit: string) {
        let gp;
        let gl;

        try {
            gp = new BigNumber(gasPrice);
            gl = new BigNumber(gasLimit);
        } catch (e) {
            gp = new BigNumber(this.averageGasPrice);
            gl = new BigNumber(MainStore.DEFAULT_GAS_LIMIT);
        }

        let amount = new BigNumber((this.accountMap.get(this.selectedAccountAddress) as IAccountInfo)
            .currencyBalanceMap[this.selectedCurrencyAddress]);

        if (this.secondTokenAddress === this.selectedCurrencyAddress) {
            amount = amount.minus(new BigNumber(gp).mul(gl));
        }

        return amount.lessThan(0) ? '0' : amount.toString();
    }

    @action
    private handleError(e: Error) {
        console.error(e);

        this.errors.push(e.message);
    }

    @action
    public setValidation(params: IValidation) {
        this.validation = params;
    }

    protected pendingIdx = 0;
    @observable protected pendingSet = new Set();

    @action
    public startPending(name: string): string {
        const pendingId = `${name}_${this.pendingIdx}`;

        this.pendingSet.add(pendingId);

        return pendingId;
    }

    @action
    public stopPending(pendingId: string): void {
        this.pendingSet.delete(pendingId);
    }

    @computed public get isPending() {
        return this.pendingSet.size > 0;
    }
}

function listToMap<T extends IHasAddress>(list: T[], map: Map<string, T>): void {
    list.forEach(item  => map.set(item.address, item));
}
