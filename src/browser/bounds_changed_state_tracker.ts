/*
    src/browser/bounds_changed_state_tracker.js
 */

const WindowTransaction = require('electron').windowTransaction;

import * as _ from 'underscore';
import * as animations from './animations.js';
import * as coreState from './core_state.js';
import * as Deferred from './deferred';
import WindowGroups from './window_groups';
import WindowGroupTransactionTracker, { ITransaction } from './window_group_transaction_tracker';
import { toSafeInt } from '../common/safe_int';
import ofEvents from './of_events';
import route from '../common/route';
import { clipBounds, windowSetBoundsToVisible } from './utils';
import { OpenFinWindow, BrowserWindow } from '../shapes';
import { windowTransaction } from 'electron';
import {RectangleBase, Rectangle} from './rectangle';

// change types
const POSITION = 0;
const SIZE = 1;
const POSITION_AND_SIZE = 2;

const isWin32 = process.platform === 'win32';

const DisableWindowGroupTracking = 'disable-window-group-tracking';
// Added Runtime argument: --disable-group-window-tracking=resize,api
// resize: core does not handle resize event for grouped windows
// api: core does not handle bound-changed event for grouped windows if generated by OpenFin API calls
// so with disable-group-window-tracking="resize,api", docking framework can customize resize behaviors
// for grouped windows

const shouldTrack = (action: string): boolean => {
    // track everything by default
    return !coreState.argo[DisableWindowGroupTracking] ||
        !coreState.argo[DisableWindowGroupTracking].split(',').includes(action);
};
const trackingResize = shouldTrack('resize');
const trackingAPI = shouldTrack('api');

interface DecoratedBounds extends RectangleBase {
    frame: boolean;
    windowState: WindowState;
}
interface BoundChanged {
    x: boolean;
    y: boolean;
    state: boolean;
    width: boolean;
    height: boolean;
    changed: boolean;
}
interface Delta {
    x: number;
    x2: number;
    y: number;
    y2: number;
    width: number;
    height: number;
}

enum WindowState {
    Normal = 'normal',
    Maximized = 'maximized',
    Minimized = 'minimized'
}
interface DeferedEvent {
    changeType: number;
    reason: string;
    name: string;
    uuid: string;
    type: string;
    deferred: boolean;
    top: number;
    left: number;
    height: number;
    width: number;
}

export default class BoundsChangedStateTracker {
    private _listeners: any;
    constructor(private uuid: string, private name: string, private browserWindow: BrowserWindow) {
        this._listeners = {
            'begin-user-bounds-change': (): void => {
                this.setUserBoundsChangeActive(true);
                const cachedBounds = this.getCachedBounds();
                const payload = { uuid, name, top: cachedBounds.y, left: cachedBounds.x };
                ofEvents.emit(route.window('begin-user-bounds-changing', uuid, name), Object.assign(payload, cachedBounds));
            },
            'end-user-bounds-change': (): void => {
                this.setUserBoundsChangeActive(false);
                const bounds = this.getCurrentBounds();
                const payload = { uuid, name, top: bounds.y, left: bounds.x };
                ofEvents.emit(route.window('end-user-bounds-changing', uuid, name), Object.assign(payload, bounds));
                this.handleBoundsChange(false, true);
            },
            'bounds-changing': (event: any, bounds: Rectangle): void => {
                this.handleBoundsChange(true, false, bounds);
            },
            'bounds-changed': (): void => {
                const ofWindow = coreState.getWindowByUuidName(uuid, name);
                const groupUuid = ofWindow ? ofWindow.groupUuid : null;

                const dispatchedChange = this.handleBoundsChange(true);
                if (groupUuid && coreState.argo['disabled-frame-groups']) {
                    return;
                }
                if (dispatchedChange) {
                    if (groupUuid) {
                        const groupLeader = WindowGroupTransactionTracker.getGroupLeader(groupUuid);
                        if (groupLeader && groupLeader.type === 'api') {
                            this.handleBoundsChange(false, true);
                        }
                    } else {
                        if (!animations.getAnimationHandler().hasWindow(this.browserWindow.id) && !this.isUserBoundsChangeActive()) {
                            this.handleBoundsChange(false, true);
                        }
                    }
                }
            },
            'synth-animate-end': (meta: any): void => {
                if (meta.bounds) {
                    // COMMENT THIS OUT FOR TESTING FLICKERING
                    this.handleBoundsChange(false, true);
                }
            },
            'visibility-changed': (event: any, isVisible: boolean): void => {
                if (!isVisible || this.browserWindow.isMinimized() || this.browserWindow.isMaximized()) {
                    this._deferred = true;
                } else {
                    this._deferred = false;
                    this.dispatchDeferredEvents();
                }
            },
            'minimize': (): void => {
                this._deferred = true;
                this.updateCachedBounds(this.getCurrentBounds());
            },
            'maximize': (): void => {
                this._deferred = true;
                this.updateCachedBounds(this.getCurrentBounds());
            },
            'restore': (): void => {
                this._deferred = false;
                windowSetBoundsToVisible(this.browserWindow);
                this.updateCachedBounds(this.getCurrentBounds());
                this.dispatchDeferredEvents();
            },
            'unmaximize': (): void => {
                this._deferred = false;
                this.updateCachedBounds(this.getCurrentBounds());
                this.dispatchDeferredEvents();
            },
            'deferred-set-bounds': (event: any, payload: any): void => {
                Deferred.handleMove(this.browserWindow.id, payload);
            }
        };
        // Cache the current bounds on construction
        this.updateCachedBounds(this.getCurrentBounds());

        // listen to relevant browser-window events
        this.hookListeners();
    }
    // a flag that represents if any change in the size has happened
    // without relying on the checking of the previous bounds which
    // may or may not be reliable depending on the previous event (
    // specifically bounds-changing)
    private sizeChanged = false;
    private positionChanged = false;

    private _cachedBounds: DecoratedBounds;
    private _userBoundsChangeActive = false;

    private _deferred = false;
    private _deferredEvents: DeferedEvent[] = [];

    private setUserBoundsChangeActive = (enabled: boolean): void => {
        this._userBoundsChangeActive = enabled;
    };

    private isUserBoundsChangeActive = (): boolean => {
        return this._userBoundsChangeActive;
    };

    private updateCachedBounds = (bounds: DecoratedBounds): void => {
        this._cachedBounds = bounds;
    };

    public getCachedBounds = (): DecoratedBounds => {
        return this._cachedBounds;
    };

    private getCurrentBounds = (): DecoratedBounds => {
        const bounds = this.browserWindow.getBounds();

        let windowState = WindowState.Normal;
        if (this.browserWindow.isMaximized()) {
            windowState = WindowState.Maximized;
        }
        if (this.browserWindow.isMinimized()) {
            windowState = WindowState.Minimized;
        }
        const frame = this.browserWindow._options.frame;
        return { ...bounds, frame, windowState };
    };

    private compareBoundsResult = (boundsOne: DecoratedBounds, boundsTwo: DecoratedBounds): BoundChanged => {
        let xDiff = boundsOne.x !== boundsTwo.x;
        let yDiff = boundsOne.y !== boundsTwo.y;
        const widthDiff = boundsOne.width !== boundsTwo.width;
        const heightDiff = boundsOne.height !== boundsTwo.height;
        const stateDiff = boundsOne.windowState !== boundsTwo.windowState;
        const changed = xDiff || yDiff || widthDiff || heightDiff /* || stateDiff*/;

        // set the changed flag only if it has not been set
        this.sizeChanged = this.sizeChanged || (widthDiff || heightDiff);
        if (this.sizeChanged) {
            xDiff = xDiff && ((boundsOne.x - boundsTwo.x) !== (boundsTwo.width - boundsOne.width));
            yDiff = yDiff && ((boundsOne.y - boundsTwo.y) !== (boundsTwo.height - boundsOne.height));
        }
        this.positionChanged = this.positionChanged || (xDiff || yDiff);


        return {
            x: xDiff,
            y: yDiff,
            width: widthDiff,
            height: heightDiff,
            state: stateDiff,
            changed
        };
    };

    private getBoundsDelta = (current: RectangleBase, cached: RectangleBase): Delta => {
        return {
            x: current.x - cached.x,
            x2: (current.x + current.width) - (cached.x + cached.width),
            y: current.y - cached.y,
            y2: (current.y + current.height) - (cached.y + cached.height),
            width: current.width - cached.width,
            height: current.height - cached.height
        };
    };

    private boundsChangeReason = (name: string, groupUuid?: string): 'animation' | 'group-animation' | 'self' | 'group' => {
        if (groupUuid) {
            const groupLeader = WindowGroupTransactionTracker.getGroupLeader(groupUuid);

            if (groupLeader && groupLeader.uuid && groupLeader.name) {
                const ofWindow = coreState.getWindowByUuidName(groupLeader.uuid, groupLeader.name);
                if (ofWindow && animations.getAnimationHandler().hasWindow(ofWindow.browserWindow.id)) {
                    return groupLeader.name === name ? 'animation' : 'group-animation';
                } else {
                    return groupLeader.name === name ? 'self' : 'group';
                }
            }
        }

        return animations.getAnimationHandler().hasWindow(this.browserWindow.id) ? 'animation' : 'self';
    };

    private sharedBoundPixelDiff = 5;

    // TODO this needs to account for if the window boarder has been crossed over
    private sharedBound = (boundOne: number, boundTwo: number): boolean => {
        return Math.abs(boundOne - boundTwo) < this.sharedBoundPixelDiff;
    };

    private handleGroupedResize = (windowToUpdate: OpenFinWindow, bounds: RectangleBase): RectangleBase => {
        if (!trackingResize) {
            return bounds;
        }
        const thisRect = Rectangle.CREATE_FROM_BOUNDS(bounds);
        const currentBounds = this.getCurrentBounds();
        const cachedBounds = this.getCachedBounds();
        const moved = thisRect.move(cachedBounds, currentBounds);
        return clipBounds(moved, windowToUpdate.browserWindow);
    };

    private checkTrackingApi = (groupLeader: ITransaction): boolean => groupLeader.type === 'api'
        ? !!trackingAPI
        : true;

    //tslint:disable-next-line
    private handleBoundsChange = (isAdditionalChangeExpected: boolean, force = false, bounds: Rectangle = null): boolean => {

        let dispatchedChange = false;

        let currentBounds = this.getCurrentBounds();
        if (bounds) {
            currentBounds = {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
              frame: currentBounds.frame,
              windowState: currentBounds.windowState
            };
        }
        const cachedBounds = this.getCachedBounds();
        const boundsCompare = this.compareBoundsResult(currentBounds, cachedBounds);
        const stateMin = boundsCompare.state && currentBounds.windowState === 'minimized';

        const eventType = isAdditionalChangeExpected ? 'bounds-changing' :
            'bounds-changed';

        const sizeChangedCriteria = [
            boundsCompare.width,
            boundsCompare.height
        ];

        const positionChangedCriteria = [
            boundsCompare.x,
            boundsCompare.y
        ];

        const isBoundsChanged = eventType === 'bounds-changed';

        // if this is to be the "last" event in a transaction, be sure to
        // any diff in the size or position towards the change type
        if (isBoundsChanged) {
            sizeChangedCriteria.push(this.sizeChanged);
            positionChangedCriteria.push(this.positionChanged);
        }

        if (boundsCompare.changed && !stateMin || force) {

            // returns true if any of the criteria are true
            const sizeChange = _.some(sizeChangedCriteria, (criteria): boolean => {
                return criteria;
            });

            const posChange = _.some(positionChangedCriteria, (criteria): boolean => {
                return criteria;
            });

            //const posChange = boundsCompare.x || boundsCompare.y;

            //0 means a change in position.
            //1 means a change in size.
            //2 means a change in position and size.
            // Default to change in position when there is no change
            const changeType = (sizeChange ? (posChange ? POSITION_AND_SIZE : SIZE) : POSITION);

            const ofWindow = coreState.getWindowByUuidName(this.uuid, this.name);
            const groupUuid = ofWindow ? ofWindow.groupUuid : null;

            // determine what caused the bounds change
            const reason = this.boundsChangeReason(this.name, groupUuid);

            // handle window group movements
            if (groupUuid && !coreState.argo['disabled-frame-groups']) {
                let groupLeader = WindowGroupTransactionTracker.getGroupLeader(groupUuid);

                if (force) {
                    if (groupLeader && groupLeader.name === this.name) {
                        // no need to notify group members for api moves since every window
                        // will already receive an end notification
                        if (groupLeader.type !== 'api') {
                            WindowGroupTransactionTracker.notifyEndTransaction(groupUuid);
                        }
                        WindowGroupTransactionTracker.clearGroup(groupUuid);
                    }
                } else {
                    if (!groupLeader || !groupLeader.name) {
                        const type = this.isUserBoundsChangeActive()
                            ? 'user'
                            : animations.getAnimationHandler().hasWindow(this.browserWindow.id)
                                ? 'animation'
                                : 'api';
                        WindowGroupTransactionTracker.setGroupLeader(groupUuid, this.name, this.uuid, type);
                    }
                }

                groupLeader = WindowGroupTransactionTracker.getGroupLeader(groupUuid);
                if (groupLeader && groupLeader.name === this.name && this.checkTrackingApi(groupLeader)) {
                    const delta = this.getBoundsDelta(currentBounds, cachedBounds);
                    let wt: windowTransaction.Transaction; // window-transaction
                    const hwndToId: { [hwnd: number]: number } = {};

                    const { flag: { noZorder, noSize, noActivate } } = WindowTransaction;
                    let flags: number;

                    if (changeType === SIZE) {
                        // this may need to change to 1 or 2 if we fix functionality for changeType 2
                        flags = noZorder + noActivate;
                    } else {
                        flags = noZorder + noSize + noActivate;
                    }

                    const windowGroup = WindowGroups.getGroup(groupUuid);
                    const winsToMove = [];
                    const positions: Map<string, RectangleBase> = new Map();
                    const setPositions: Array<() => void> = [];

                    for (let i = 0; i < windowGroup.length; i++) {
                        if (windowGroup[i].name !== this.name) {
                            winsToMove.push(windowGroup[i]);
                        }
                        positions.set(windowGroup[i].name, windowGroup[i].browserWindow.getBounds());
                    }

                    for (let i = 0; i < winsToMove.length; i++) {
                        const win = winsToMove[i];

                        win.browserWindow.bringToFront(); // maybe just do this once?
                        const winBounds = positions.get(win.name);

                        const bounds = (changeType === SIZE)
                            // here bounds compare and delta are from the window that is resizing
                            ? this.handleGroupedResize(win, winBounds)
                            : winBounds;

                        let { x, y } = bounds;
                        const { width, height } = bounds;

                        // If it is a change in position (working correctly) or a change in position and size (not yet implemented)
                        if (changeType === POSITION || changeType === POSITION_AND_SIZE) {
                            x = toSafeInt(x + delta.x, x);
                            y = toSafeInt(y + delta.y, y);
                        }

                        if (isWin32) {
                            const hwnd = parseInt(win.browserWindow.nativeId, 16);

                            if (!wt) {
                                wt = new WindowTransaction.Transaction(0);

                                wt.on('deferred-set-window-pos', (event, payload: any): void => {
                                    payload.forEach((winPos: any): void => {
                                        const bwId = hwndToId[parseInt(winPos.hwnd)];
                                        Deferred.handleMove(bwId, winPos);
                                    });
                                });
                            }
                            hwndToId[hwnd] = win.browserWindow.id;
                            if (win.browserWindow.isMaximized()) {
                                win.browserWindow.unmaximize();
                            }

                            /*
                                Leave this in here (commented out) for now. The idea is to only actually move the
                                windows after all window positions are known in order to detect if any min/max
                                restriction has been violated. The reason it is not included here is that it changes
                                the .deferred and .reason values on the event payloads in a way that breaks tests,
                                though it may be the desired behavior. This will be revisited as we evaluate making
                                the entire transaction happen deferred window bounds.


                                setPositions.push(() => {
                                    const myBounds = positions.get(win.name);
                                    const { x, y, width, height } = myBounds;
                                    const [w, h] = [width, height];
                                    wt.setWindowPos(hwnd, { x, y, w, h, flags });
                                });
                             */
                            const [w, h] = [width, height];
                            wt.setWindowPos(hwnd, { x, y, w, h, flags });

                        } else {
                            if (win.browserWindow.isFullScreen()) {
                                win.browserWindow.setFullScreen(false);
                            } else if (win.browserWindow.isMaximized()) {
                                win.browserWindow.unmaximize();
                            } else {
                                positions.set(win.name, { x, y, width, height });

                                // see note above about deferred moves
                                // setPositions.push(() => {
                                //     win.browserWindow.setBounds(positions.get(win.name));
                                // });
                                win.browserWindow.setBounds(positions.get(win.name));
                            }
                        }
                    }

                    // see note above about deferred moves
                    // setPositions.forEach(boundsSet => boundsSet());

                    if (wt) {
                        wt.commit();
                    }
                }
            }

            const payload = {
                changeType,
                reason,
                name: this.name,
                uuid: this.uuid,
                type: eventType,
                deferred: this._deferred,
                top: currentBounds.y,
                left: currentBounds.x,
                height: currentBounds.height,
                width: currentBounds.width
            };

            if (this._deferred) {
                this._deferredEvents.push(payload);
            } else {
                this.browserWindow.emit('synth-bounds-change', payload);
            }

            dispatchedChange = true;
        }

        this.updateCachedBounds(currentBounds);

        // this represents the changed event, reset the overall changed flag
        if (!isAdditionalChangeExpected) {
            this.sizeChanged = false;
            this.positionChanged = false;
        }

        return dispatchedChange;
    };

    private collapseEventReasonTypes = (eventsList: DeferedEvent[]): DeferedEvent[] => {
        const eventGroups: DeferedEvent[][] = [];

        eventsList.forEach((event, index): void => {
            if (index === 0 || event.reason !== eventsList[index - 1].reason) {
                const list = [];
                list.push(event);
                eventGroups.push(list);
            } else {
                _.last(eventGroups).push(event);
            }
        });

        return eventGroups.map((group): DeferedEvent => {
            let sizeChange = false;
            let posChange = false;

            group.forEach((event): void => {
                if (event.changeType === POSITION) {
                    posChange = true;
                } else if (event.changeType === SIZE) {
                    sizeChange = true;
                } else {
                    sizeChange = true;
                    posChange = true;
                }
            });

            const lastEvent = _.last(group);
            lastEvent.changeType = (sizeChange ? (posChange ? POSITION_AND_SIZE : SIZE) : POSITION);

            return lastEvent;
        });
    };

    private dispatchDeferredEvents = (): void => {
        const boundsChangedEvents = this._deferredEvents.filter((event): boolean => {
            return event.type === 'bounds-changed';
        });

        const reasonGroupedEvents = this.collapseEventReasonTypes(boundsChangedEvents);

        reasonGroupedEvents.forEach((event): void => {
            event.type = 'bounds-changing';
            this.browserWindow.emit('synth-bounds-change', event);
            event.type = 'bounds-changed';
            this.browserWindow.emit('synth-bounds-change', event);
        });

        this._deferredEvents.length = 0;
    };


    private endWindowGroupTransactionListener = (groupUuid: string): void => {
        const ofWindow = coreState.getWindowByUuidName(this.uuid, this.name);
        const _groupUuid = ofWindow ? ofWindow.groupUuid : null;

        if (_groupUuid === groupUuid) {
            const groupLeader = WindowGroupTransactionTracker.getGroupLeader(groupUuid);

            if (groupLeader && groupLeader.name !== this.name) {
                this.handleBoundsChange(false, true);
            }
        }
    };

    private updateEvents = (register: boolean): void => {
        const listenerFn = register ? 'on' : 'removeListener';

        Object.keys(this._listeners).forEach((key): void => {
            this.browserWindow[listenerFn](key, this._listeners[key]);
        });

        WindowGroupTransactionTracker[listenerFn]('end-window-group-transaction', this.endWindowGroupTransactionListener);
    };

    private hookListeners = (): void => {
        this.updateEvents(true);
    };

    private unHookListeners = (): void => {
        this.updateEvents(false);
    };

    // Remove all event listeners this instance subscribed on
    public teardown = (): void => {
        this.unHookListeners();
    };

}