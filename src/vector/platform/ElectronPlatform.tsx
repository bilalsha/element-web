/*
Copyright 2016 Aviral Dasgupta
Copyright 2016 OpenMarket Ltd
Copyright 2019 Michael Telatynski <7t3chguy@gmail.com>
Copyright 2018 - 2021 New Vector Ltd
Copyright 2022 Šimon Brandner <simon.bra.ag@gmail.com>

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import { UpdateCheckStatus } from "matrix-react-sdk/src/BasePlatform";
import BaseEventIndexManager, {
    ICrawlerCheckpoint,
    IEventAndProfile,
    IIndexStats,
    ISearchArgs,
} from 'matrix-react-sdk/src/indexing/BaseEventIndexManager';
import dis from 'matrix-react-sdk/src/dispatcher/dispatcher';
import { _t } from 'matrix-react-sdk/src/languageHandler';
import SdkConfig from 'matrix-react-sdk/src/SdkConfig';
import * as rageshake from 'matrix-react-sdk/src/rageshake/rageshake';
import { MatrixClient } from "matrix-js-sdk/src/client";
import { Room } from "matrix-js-sdk/src/models/room";
import Modal from "matrix-react-sdk/src/Modal";
import InfoDialog from "matrix-react-sdk/src/components/views/dialogs/InfoDialog";
import Spinner from "matrix-react-sdk/src/components/views/elements/Spinner";
import React from "react";
import { randomString } from "matrix-js-sdk/src/randomstring";
import { Action } from "matrix-react-sdk/src/dispatcher/actions";
import { ActionPayload } from "matrix-react-sdk/src/dispatcher/payloads";
import { showToast as showUpdateToast } from "matrix-react-sdk/src/toasts/UpdateToast";
import { CheckUpdatesPayload } from "matrix-react-sdk/src/dispatcher/payloads/CheckUpdatesPayload";
import ToastStore from "matrix-react-sdk/src/stores/ToastStore";
import GenericExpiringToast from "matrix-react-sdk/src/components/views/toasts/GenericExpiringToast";
import { IMatrixProfile, IEventWithRoomId as IMatrixEvent, IResultRoomEvents } from "matrix-js-sdk/src/@types/search";
import { logger } from "matrix-js-sdk/src/logger";
import { MatrixEvent } from "matrix-js-sdk/src/models/event";

import VectorBasePlatform from './VectorBasePlatform';

const electron = window.electron;
const isMac = navigator.platform.toUpperCase().includes('MAC');

function platformFriendlyName(): string {
    // used to use window.process but the same info is available here
    if (navigator.userAgent.includes('Macintosh')) {
        return 'macOS';
    } else if (navigator.userAgent.includes('FreeBSD')) {
        return 'FreeBSD';
    } else if (navigator.userAgent.includes('OpenBSD')) {
        return 'OpenBSD';
    } else if (navigator.userAgent.includes('SunOS')) {
        return 'SunOS';
    } else if (navigator.userAgent.includes('Windows')) {
        return 'Windows';
    } else if (navigator.userAgent.includes('Linux')) {
        return 'Linux';
    } else {
        return 'Unknown';
    }
}

function _onAction(payload: ActionPayload) {
    // Whitelist payload actions, no point sending most across
    if (['call_state'].includes(payload.action)) {
        electron.send('app_onAction', payload);
    }
}

function getUpdateCheckStatus(status: boolean | string) {
    if (status === true) {
        return { status: UpdateCheckStatus.Downloading };
    } else if (status === false) {
        return { status: UpdateCheckStatus.NotAvailable };
    } else {
        return {
            status: UpdateCheckStatus.Error,
            detail: status,
        };
    }
}

interface IPCPayload {
    id?: number;
    error?: string;
    reply?: any;
}

class SeshatIndexManager extends BaseEventIndexManager {
    private pendingIpcCalls: Record<number, { resolve, reject }> = {};
    private nextIpcCallId = 0;

    constructor() {
        super();

        electron.on('seshatReply', this.onIpcReply);
    }

    private async ipcCall(name: string, ...args: any[]): Promise<any> {
        // TODO this should be moved into the preload.js file.
        const ipcCallId = ++this.nextIpcCallId;
        return new Promise((resolve, reject) => {
            this.pendingIpcCalls[ipcCallId] = { resolve, reject };
            window.electron.send('seshat', { id: ipcCallId, name, args });
        });
    }

    private onIpcReply = (ev: {}, payload: IPCPayload) => {
        if (payload.id === undefined) {
            logger.warn("Ignoring IPC reply with no ID");
            return;
        }

        if (this.pendingIpcCalls[payload.id] === undefined) {
            logger.warn("Unknown IPC payload ID: " + payload.id);
            return;
        }

        const callbacks = this.pendingIpcCalls[payload.id];
        delete this.pendingIpcCalls[payload.id];
        if (payload.error) {
            callbacks.reject(payload.error);
        } else {
            callbacks.resolve(payload.reply);
        }
    };

    async supportsEventIndexing(): Promise<boolean> {
        return this.ipcCall('supportsEventIndexing');
    }

    async initEventIndex(userId: string, deviceId: string): Promise<void> {
        return this.ipcCall('initEventIndex', userId, deviceId);
    }

    async addEventToIndex(ev: IMatrixEvent, profile: IMatrixProfile): Promise<void> {
        return this.ipcCall('addEventToIndex', ev, profile);
    }

    async deleteEvent(eventId: string): Promise<boolean> {
        return this.ipcCall('deleteEvent', eventId);
    }

    async isEventIndexEmpty(): Promise<boolean> {
        return this.ipcCall('isEventIndexEmpty');
    }

    async isRoomIndexed(roomId: string): Promise<boolean> {
        return this.ipcCall('isRoomIndexed', roomId);
    }

    async commitLiveEvents(): Promise<void> {
        return this.ipcCall('commitLiveEvents');
    }

    async searchEventIndex(searchConfig: ISearchArgs): Promise<IResultRoomEvents> {
        return this.ipcCall('searchEventIndex', searchConfig);
    }

    async addHistoricEvents(
        events: IEventAndProfile[],
        checkpoint: ICrawlerCheckpoint | null,
        oldCheckpoint: ICrawlerCheckpoint | null,
    ): Promise<boolean> {
        return this.ipcCall('addHistoricEvents', events, checkpoint, oldCheckpoint);
    }

    async addCrawlerCheckpoint(checkpoint: ICrawlerCheckpoint): Promise<void> {
        return this.ipcCall('addCrawlerCheckpoint', checkpoint);
    }

    async removeCrawlerCheckpoint(checkpoint: ICrawlerCheckpoint): Promise<void> {
        return this.ipcCall('removeCrawlerCheckpoint', checkpoint);
    }

    async loadFileEvents(args): Promise<IEventAndProfile[]> {
        return this.ipcCall('loadFileEvents', args);
    }

    async loadCheckpoints(): Promise<ICrawlerCheckpoint[]> {
        return this.ipcCall('loadCheckpoints');
    }

    async closeEventIndex(): Promise<void> {
        return this.ipcCall('closeEventIndex');
    }

    async getStats(): Promise<IIndexStats> {
        return this.ipcCall('getStats');
    }

    async getUserVersion(): Promise<number> {
        return this.ipcCall('getUserVersion');
    }

    async setUserVersion(version: number): Promise<void> {
        return this.ipcCall('setUserVersion', version);
    }

    async deleteEventIndex(): Promise<void> {
        return this.ipcCall('deleteEventIndex');
    }
}

export default class ElectronPlatform extends VectorBasePlatform {
    private eventIndexManager: BaseEventIndexManager = new SeshatIndexManager();
    private pendingIpcCalls: Record<number, { resolve, reject }> = {};
    private nextIpcCallId = 0;
    // this is the opaque token we pass to the HS which when we get it in our callback we can resolve to a profile
    private ssoID: string = randomString(32);

    constructor() {
        super();

        dis.register(_onAction);
        /*
            IPC Call `check_updates` returns:
            true if there is an update available
            false if there is not
            or the error if one is encountered
         */
        electron.on('check_updates', (event, status) => {
            dis.dispatch<CheckUpdatesPayload>({
                action: Action.CheckUpdates,
                ...getUpdateCheckStatus(status),
            });
        });

        // try to flush the rageshake logs to indexeddb before quit.
        electron.on('before-quit', function() {
            logger.log('element-desktop closing');
            rageshake.flush();
        });

        electron.on('ipcReply', this.onIpcReply);
        electron.on('update-downloaded', this.onUpdateDownloaded);

        electron.on('preferences', () => {
            dis.fire(Action.ViewUserSettings);
        });

        electron.on('userDownloadCompleted', (ev, { id, name }) => {
            const key = `DOWNLOAD_TOAST_${id}`;

            const onAccept = () => {
                electron.send('userDownloadAction', { id, open: true });
                ToastStore.sharedInstance().dismissToast(key);
            };

            const onDismiss = () => {
                electron.send('userDownloadAction', { id });
            };

            ToastStore.sharedInstance().addOrReplaceToast({
                key,
                title: _t("Download Completed"),
                props: {
                    description: name,
                    acceptLabel: _t("Open"),
                    onAccept,
                    dismissLabel: _t("Dismiss"),
                    onDismiss,
                    numSeconds: 10,
                },
                component: GenericExpiringToast,
                priority: 99,
            });
        });

        this.ipcCall("startSSOFlow", this.ssoID);
    }

    async getConfig(): Promise<{}> {
        return this.ipcCall('getConfig');
    }

    onUpdateDownloaded = async (ev, { releaseNotes, releaseName }) => {
        dis.dispatch<CheckUpdatesPayload>({
            action: Action.CheckUpdates,
            status: UpdateCheckStatus.Ready,
        });
        if (this.shouldShowUpdate(releaseName)) {
            showUpdateToast(await this.getAppVersion(), releaseName, releaseNotes);
        }
    };

    getHumanReadableName(): string {
        return 'Electron Platform'; // no translation required: only used for analytics
    }

    /**
     * Return true if platform supports multi-language
     * spell-checking, otherwise false.
     */
    supportsMultiLanguageSpellCheck(): boolean {
        // Electron uses OS spell checking on macOS, so no need for in-app options
        if (isMac) return false;
        return true;
    }

    public allowOverridingNativeContextMenus(): boolean {
        return true;
    }

    public setNotificationCount(count: number): void {
        if (this.notificationCount === count) return;
        super.setNotificationCount(count);

        electron.send('setBadgeCount', count);
    }

    supportsNotifications(): boolean {
        return true;
    }

    maySendNotifications(): boolean {
        return true;
    }

    displayNotification(title: string, msg: string, avatarUrl: string, room: Room, ev?: MatrixEvent): Notification {
        // GNOME notification spec parses HTML tags for styling...
        // Electron Docs state all supported linux notification systems follow this markup spec
        // https://github.com/electron/electron/blob/master/docs/tutorial/desktop-environment-integration.md#linux
        // maybe we should pass basic styling (italics, bold, underline) through from MD
        // we only have to strip out < and > as the spec doesn't include anything about things like &amp;
        // so we shouldn't assume that all implementations will treat those properly. Very basic tag parsing is done.
        if (navigator.userAgent.includes('Linux')) {
            msg = msg.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }

        const notification = super.displayNotification(
            title,
            msg,
            avatarUrl,
            room,
            ev,
        );

        const handler = notification.onclick as Function;
        notification.onclick = () => {
            handler?.();
            this.ipcCall('focusWindow');
        };

        return notification;
    }

    loudNotification(ev: MatrixEvent, room: Room) {
        electron.send('loudNotification');
    }

    async getAppVersion(): Promise<string> {
        return this.ipcCall('getAppVersion');
    }

    supportsAutoLaunch(): boolean {
        return true;
    }

    async getAutoLaunchEnabled(): Promise<boolean> {
        return this.ipcCall('getAutoLaunchEnabled');
    }

    async setAutoLaunchEnabled(enabled: boolean): Promise<void> {
        return this.ipcCall('setAutoLaunchEnabled', enabled);
    }

    supportsWarnBeforeExit(): boolean {
        return true;
    }

    async shouldWarnBeforeExit(): Promise<boolean> {
        return this.ipcCall('shouldWarnBeforeExit');
    }

    async setWarnBeforeExit(enabled: boolean): Promise<void> {
        return this.ipcCall('setWarnBeforeExit', enabled);
    }

    supportsAutoHideMenuBar(): boolean {
        // This is irelevant on Mac as Menu bars don't live in the app window
        return !isMac;
    }

    async getAutoHideMenuBarEnabled(): Promise<boolean> {
        return this.ipcCall('getAutoHideMenuBarEnabled');
    }

    async setAutoHideMenuBarEnabled(enabled: boolean): Promise<void> {
        return this.ipcCall('setAutoHideMenuBarEnabled', enabled);
    }

    supportsMinimizeToTray(): boolean {
        // Things other than Mac support tray icons
        return !isMac;
    }

    async getMinimizeToTrayEnabled(): Promise<boolean> {
        return this.ipcCall('getMinimizeToTrayEnabled');
    }

    async setMinimizeToTrayEnabled(enabled: boolean): Promise<void> {
        return this.ipcCall('setMinimizeToTrayEnabled', enabled);
    }

    async canSelfUpdate(): Promise<boolean> {
        const feedUrl = await this.ipcCall('getUpdateFeedUrl');
        return Boolean(feedUrl);
    }

    startUpdateCheck() {
        super.startUpdateCheck();
        electron.send('check_updates');
    }

    installUpdate() {
        // IPC to the main process to install the update, since quitAndInstall
        // doesn't fire the before-quit event so the main process needs to know
        // it should exit.
        electron.send('install_update');
    }

    getDefaultDeviceDisplayName(): string {
        const brand = SdkConfig.get().brand;
        return _t('%(brand)s Desktop (%(platformName)s)', {
            brand,
            platformName: platformFriendlyName(),
        });
    }

    screenCaptureErrorString(): string | null {
        return null;
    }

    requestNotificationPermission(): Promise<string> {
        return Promise.resolve('granted');
    }

    reload() {
        window.location.reload();
    }

    private async ipcCall(name: string, ...args: any[]): Promise<any> {
        const ipcCallId = ++this.nextIpcCallId;
        return new Promise((resolve, reject) => {
            this.pendingIpcCalls[ipcCallId] = { resolve, reject };
            window.electron.send('ipcCall', { id: ipcCallId, name, args });
            // Maybe add a timeout to these? Probably not necessary.
        });
    }

    private onIpcReply = (ev, payload) => {
        if (payload.id === undefined) {
            logger.warn("Ignoring IPC reply with no ID");
            return;
        }

        if (this.pendingIpcCalls[payload.id] === undefined) {
            logger.warn("Unknown IPC payload ID: " + payload.id);
            return;
        }

        const callbacks = this.pendingIpcCalls[payload.id];
        delete this.pendingIpcCalls[payload.id];
        if (payload.error) {
            callbacks.reject(payload.error);
        } else {
            callbacks.resolve(payload.reply);
        }
    };

    getEventIndexingManager(): BaseEventIndexManager | null {
        return this.eventIndexManager;
    }

    async setLanguage(preferredLangs: string[]) {
        return this.ipcCall('setLanguage', preferredLangs);
    }

    setSpellCheckLanguages(preferredLangs: string[]) {
        this.ipcCall('setSpellCheckLanguages', preferredLangs).catch(error => {
            logger.log("Failed to send setSpellCheckLanguages IPC to Electron");
            logger.error(error);
        });
    }

    async getSpellCheckLanguages(): Promise<string[]> {
        return this.ipcCall('getSpellCheckLanguages');
    }

    async getDesktopCapturerSources(options: GetSourcesOptions): Promise<Array<DesktopCapturerSource>> {
        return this.ipcCall('getDesktopCapturerSources', options);
    }

    supportsDesktopCapturer(): boolean {
        return true;
    }

    async getAvailableSpellCheckLanguages(): Promise<string[]> {
        return this.ipcCall('getAvailableSpellCheckLanguages');
    }

    getSSOCallbackUrl(fragmentAfterLogin: string): URL {
        const url = super.getSSOCallbackUrl(fragmentAfterLogin);
        url.protocol = "element";
        url.searchParams.set("element-desktop-ssoid", this.ssoID);
        return url;
    }

    startSingleSignOn(mxClient: MatrixClient, loginType: "sso" | "cas", fragmentAfterLogin: string, idpId?: string) {
        // this will get intercepted by electron-main will-navigate
        super.startSingleSignOn(mxClient, loginType, fragmentAfterLogin, idpId);
        Modal.createTrackedDialog('Electron', 'SSO', InfoDialog, {
            title: _t("Go to your browser to complete Sign In"),
            description: <Spinner />,
        });
    }

    public navigateForwardBack(back: boolean): void {
        this.ipcCall(back ? "navigateBack" : "navigateForward");
    }

    public overrideBrowserShortcuts(): boolean {
        return true;
    }

    async getPickleKey(userId: string, deviceId: string): Promise<string | null> {
        try {
            return await this.ipcCall('getPickleKey', userId, deviceId);
        } catch (e) {
            // if we can't connect to the password storage, assume there's no
            // pickle key
            return null;
        }
    }

    async createPickleKey(userId: string, deviceId: string): Promise<string | null> {
        try {
            return await this.ipcCall('createPickleKey', userId, deviceId);
        } catch (e) {
            // if we can't connect to the password storage, assume there's no
            // pickle key
            return null;
        }
    }

    async destroyPickleKey(userId: string, deviceId: string): Promise<void> {
        try {
            await this.ipcCall('destroyPickleKey', userId, deviceId);
        } catch (e) {}
    }
}
