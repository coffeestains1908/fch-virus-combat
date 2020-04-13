import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

import {
    __STATS__,
    __STATS__ITEMS, CONTRIBS, MESSAGES,
    REQUESTS,
    REQUESTS__ITEMS,
    USERS
} from "./@core/firestore-collections";
import {
    RequestItem,
    Request,
    RequestStatus,
    ContributionDetails,
    RequestStats, DEFAULT_REQUEST_ITEMS
} from "./@core/firestore-interfaces/request";
import {User, UserRoles} from "./@core/firestore-interfaces/user";
import {
    sendNewContributionEmail,
    sendPasswordlessSignInEmail,
    sendRegistrationSuccessEmail,
    sendRejectedByAdminEmail,
    sendVerifiedByAdminEmail
} from "./mailer";

import FieldValue = admin.firestore.FieldValue;
import {MessageDocument} from "./@core/firestore-interfaces/messages";

admin.initializeApp();

const auth = admin.auth();
const db = admin.firestore();

const regionName = 'asia-east2';

export interface MyCustomClaims {
    admin: boolean;
    verifiedByAdmin: boolean;
}

exports.userOnCreate = functions.region(regionName).auth.user().onCreate(async user => {
    try {
        await sendRegistrationSuccessEmail(user.email as string);
    } catch (e) {
    }
    return;
});

exports.userOnDelete = functions.region(regionName).auth.user().onDelete(async user => {
    const uid = user.uid;
    const batch = db.batch();
    const userRef = db.collection('/users').doc(uid);

    batch.delete(userRef);

    try {
        await batch.commit();
        return true;
    } catch (e) {
        console.error(e);
        return false;
    }
});

exports.usersOnWrite = functions.region(regionName).firestore
    .document(`${USERS}/{userId}`)
    .onWrite(async (change, context) => {
        const uid = context.params.userId;

        if (uid === __STATS__) {
            return;
        }

        return new Promise(async (resolve, reject) => {
            const firestore = admin.firestore();
            const batch = firestore.batch();
            const statsRef = firestore.collection(USERS).doc(__STATS__);

            const after = <User>change.after.data();
            try {
                if (!after) {
                    // user deleted
                    const before = <User>change.before.data();

                    if (before.roles?.includes('agency')) {
                        const agencies = -1;
                        let pendingMembers = 0;
                        if (before.rejectedByAdmin) {
                            pendingMembers = -1;
                        }
                        batch.update(statsRef, {
                            agencies: admin.firestore.FieldValue.increment(agencies),
                            pendingMembers: admin.firestore.FieldValue.increment(pendingMembers)
                        });
                    }
                } else {
                    // manage custom claims
                    const customClaims: MyCustomClaims = {
                        admin: false,
                        verifiedByAdmin: false,
                    };
                    const rolesAfter = after.roles;
                    const findRole: UserRoles = 'admin';
                    if (rolesAfter && rolesAfter.includes(findRole)) {
                        customClaims.admin = true;
                    }

                    let verifiedByAdmin = false;
                    let rejectedByAdmin = false;
                    if (change.before.data()) {
                        const before = <User>change.before.data();

                        const agencies = 0;
                        let pendingMembers = 0;

                        if (!before.verifiedByAdmin && after.verifiedByAdmin) {
                            verifiedByAdmin = true;
                            if (after.roles?.includes('agency')) {
                                pendingMembers = -1;
                            }
                        }

                        if (!before.rejectedByAdmin && after.rejectedByAdmin) {
                            rejectedByAdmin = true;
                        }

                        batch.update(statsRef, {
                            agencies: admin.firestore.FieldValue.increment(agencies),
                            pendingMembers: admin.firestore.FieldValue.increment(pendingMembers)
                        });
                    } else {
                        if (after.roles?.includes('agency')) {
                            const agencies = 1;
                            let pendingMembers = 0;
                            if (!after.verifiedByAdmin) {
                                pendingMembers = 1;
                            }
                            batch.update(statsRef, {
                                agencies: admin.firestore.FieldValue.increment(agencies),
                                pendingMembers: admin.firestore.FieldValue.increment(pendingMembers)
                            });
                        }
                    }

                    if (verifiedByAdmin) {
                        customClaims.verifiedByAdmin = true;
                        await sendVerifiedByAdminEmail(after.email);
                    }

                    if (rejectedByAdmin) {
                        await sendRejectedByAdminEmail(after.email);
                        await admin.auth().deleteUser(after.userId as string);
                    } else {
                        await admin.auth().setCustomUserClaims(uid, customClaims);
                    }
                }

                await batch.commit();
                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });

exports.registerUser = functions.region(regionName).https.onCall((data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    } else if (!context.auth.token.admin) {
        throw new functions.https.HttpsError('failed-precondition', 'Admin-only function');
    } else {
        const userAccount = data;
        return auth.createUser({
            email: userAccount.email,
        }).then(async userRecord => {
            const link = await auth.generateSignInWithEmailLink(userAccount.email, {url: 'https://neuon-hackathon-holmes.web.app/finish-sign-up'});
            await sendPasswordlessSignInEmail(userAccount.email, link);
            return userRecord.uid;
        }).catch(e => {
            const errorInfo = e.errorInfo;
            console.info(errorInfo);
            throw new functions.https.HttpsError('internal', errorInfo.code, errorInfo.message);
        });
    }
});

exports.deleteUser = functions.region(regionName).https.onCall((data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError('failed-precondition', 'The function must be called ' +
            'while authenticated.');
    } else if (!context.auth.token.admin) {
        throw new functions.https.HttpsError('failed-precondition', 'Admin-only function');
    } else {
        const userId = data.userId;
        console.info(userId);
        return auth.deleteUser(userId).then(() => {
            return true;
        }).catch(e => {
            throw e;
        });
    }
});

exports.requestStatusWatcher = functions.region(regionName).firestore
    .document(`${REQUESTS}/{requestId}`)
    .onWrite((change, context) => {
        const requestId = context.params.requestId;

        const firestore = admin.firestore();
        const batch = firestore.batch();

        const statsRef = firestore.collection(REQUESTS).doc(__STATS__);
        const requestRef = firestore.collection(REQUESTS).doc(requestId);
        let userRef: FirebaseFirestore.DocumentReference<any>;

        const dataBefore = change.before.data() as Request;
        const dataAfter = change.after.data() as Request;

        let activeRequest = 0;
        let completeRequest = 0;
        let requestStatus = null;

        if (!dataAfter) {
            // deleted
            if (dataBefore.status === <RequestStatus>'active') {
                activeRequest = -1;
            } else if (dataBefore.status === <RequestStatus>'complete') {
                completeRequest = -1;
            }

            // remove active items from user
            userRef = firestore.collection(USERS).doc(dataBefore.user);
            const activeItemsBefore = dataBefore.active as string[];
            if (activeItemsBefore) {
                activeItemsBefore.forEach(item => {
                    batch.update(userRef, {
                        ['_recentNeededItems.' + item]: FieldValue.increment(-1)
                    });
                });
            }
        } else {
            if (dataBefore) {
                // updated
                const activeListAfter = dataAfter.active;
                const completeListAfter = dataAfter.complete;
                const activeListBefore = dataBefore.active;
                const completeListBefore = dataBefore.complete;

                // check if list is changed
                if (completeListAfter && activeListAfter) {
                    const activeListChanged = activeListBefore !== activeListAfter;
                    const completeListChanged = completeListBefore !== completeListAfter;
                    if (activeListChanged || completeListChanged) {
                        if (activeListAfter.length === 0 && completeListAfter.length > 0) {
                            if (dataAfter.status !== <RequestStatus>'complete') {
                                requestStatus = <RequestStatus>'complete';
                                completeRequest = 1;
                                activeRequest = -1;
                            }
                        } else {
                            if (dataAfter.status !== <RequestStatus>'active') {
                                requestStatus = <RequestStatus>'active';
                                completeRequest = -1;
                                activeRequest = 1;
                            }
                        }
                    }
                }
            } else {
                // created
                const activeList = dataAfter.active;
                const completeList = dataAfter.complete;

                if (activeList && completeList) {
                    // change status
                    if (activeList.length === 0 && completeList.length > 0) {
                        requestStatus = <RequestStatus>'complete';
                    } else {
                        requestStatus = <RequestStatus>'active';
                    }
                }

                if (dataAfter.status === <RequestStatus>'active') {
                    console.info('is active');
                    activeRequest = 1;
                } else if (dataAfter.status === <RequestStatus>'complete') {
                    console.info('is complete');
                    completeRequest = 1;
                }
            }
        }

        batch.update(statsRef, {
            active: FieldValue.increment(activeRequest),
            complete: FieldValue.increment(completeRequest),
        });

        if (requestStatus) {
            batch.update(requestRef, {status: requestStatus});
        }

        return batch.commit();
    });

exports.contributionWatcher = functions.region(regionName).firestore
    .document(`${CONTRIBS}/{contribId}`)
    .onWrite((change, context) => {
        const firestore = admin.firestore();

        const contribId = context.params.contribId;
        const contribRef = firestore.collection(CONTRIBS).doc(contribId);

        const dataBefore = change.before.data() as ContributionDetails;
        const dataAfter = change.after.data() as ContributionDetails;

        const batchRequest = firestore.batch();

        return new Promise(async (resolve, reject) => {
            try {
                if (!dataBefore) {
                    if (dataAfter && dataAfter.requestId) {
                        const requestDoc = await firestore.collection(REQUESTS)
                            .doc(dataAfter.requestId).get();
                        const requestData = requestDoc.data() as Request;
                        await contribRef.update({
                            receiverId: requestData.user
                        });

                        const items = dataAfter.contributionItems;
                        const contributorName = dataAfter.sender.name;
                        const remarks = dataAfter.remarks;

                        return sendNewContributionEmail(
                            requestData.userInfo?.email || '',
                            contributorName,
                            items,
                            remarks
                        );
                    }
                } else {
                    if (dataAfter) {
                        const statusAfter = dataAfter.status;
                        const requestId = dataAfter.requestId;

                        if (requestId) {
                            const requestRef = firestore.collection(REQUESTS)
                                .doc(requestId).collection(REQUESTS__ITEMS);

                            if (statusAfter === 'received') {
                                const itemsReceived = dataAfter.contributionItemsReceived;
                                if (itemsReceived) {
                                    itemsReceived.forEach(item => {
                                        batchRequest.update(requestRef.doc(item.name), {qtyFilled: item.qty});
                                    });
                                }
                            }
                        }
                    }
                }

                await Promise.all([
                    batchRequest.commit()
                ]);

                resolve();
            } catch (e) {
                reject(e);
            }
        });
    });

/**
 * update __STATS__ in REQUESTS
 *
 * - will delete the request item if qtyNeed <= 0
 */
exports.demandsStatsWatcher = functions.region(regionName).firestore
    .document(`${REQUESTS}/${__STATS__}/${__STATS__ITEMS}/{requestItemId}`)
    .onWrite((change, context) => {
        const itemName = context.params.requestItemId;

        const firestore = admin.firestore();
        const batchStats = firestore.batch();

        const statsRef = firestore.collection(REQUESTS).doc(__STATS__);
        const itemsRef = statsRef.collection(__STATS__ITEMS);
        const itemRef = itemsRef.doc(itemName);

        const dataAfter = change.after.data() as RequestItem;

        if (dataAfter) {
            const qtyNeed = dataAfter.qtyNeed;

            if (qtyNeed <= 0) {
                batchStats.delete(itemRef);
            }
        }

        return Promise.all([
            batchStats.commit(),
        ]).then(() => {
            console.info('ok');
            return true;
        }).catch(e => {
            console.error(e);
            return false;
        });
    });

/**
 * remember that this can be in 2 mode;
 * 1. parent is deleted
 * 2. parent is not deleted
 */
exports.demandsWatcher = functions.region(regionName).firestore
    .document(`${REQUESTS}/{requestId}/${REQUESTS__ITEMS}/{requestItemId}`)
    .onWrite(async (change, context) => {
        const requestId = context.params.requestId;
        const itemName = context.params.requestItemId;

        const firestore = admin.firestore();
        const batchStats = firestore.batch();
        const batchRequest = firestore.batch();
        const batchUser = firestore.batch();

        const requestRef = firestore.collection(REQUESTS).doc(requestId);

        const statsRef = firestore.collection(REQUESTS).doc(__STATS__);
        const itemsRef = statsRef.collection(__STATS__ITEMS);
        const itemRef = itemsRef.doc(itemName);
        let userRef;

        // check if parent is deleted
        const requestDoc = await requestRef.get();
        if (requestDoc.exists) {
            const requestData = requestDoc.data() as Request;
            const userId = requestData.user;
            userRef = firestore.collection(USERS).doc(userId);
        }

        const dataBefore = change.before.data() as RequestItem;
        const dataAfter = change.after.data() as RequestItem;

        let needIncrement: admin.firestore.FieldValue;
        let fillIncrement: admin.firestore.FieldValue;
        let itemNeed = FieldValue.arrayRemove(itemName);
        let itemComplete = FieldValue.arrayRemove(itemName);
        let recentItemNeedIncrement = 0;

        if (!dataAfter) {
            // item deleted
            needIncrement = admin.firestore.FieldValue.increment(-dataBefore.qtyNeed);
            fillIncrement = admin.firestore.FieldValue.increment(-dataBefore.qtyFilled);
            recentItemNeedIncrement = -1;
        } else {
            if (dataBefore) {
                // item changed
                needIncrement = admin.firestore.FieldValue.increment(dataAfter.qtyNeed - dataBefore.qtyNeed);
                fillIncrement = admin.firestore.FieldValue.increment(dataAfter.qtyFilled - dataBefore.qtyFilled);

                const beforeWasCompleted = dataBefore.qtyFilled >= dataBefore.qtyNeed;
                const afterIsComplete = dataAfter.qtyFilled >= dataAfter.qtyNeed;

                if (!beforeWasCompleted && afterIsComplete) {
                    recentItemNeedIncrement = -1;
                }
                if (beforeWasCompleted && !afterIsComplete) {
                    recentItemNeedIncrement = 1;
                }
            } else {
                // item added
                needIncrement = admin.firestore.FieldValue.increment(dataAfter.qtyNeed);
                fillIncrement = admin.firestore.FieldValue.increment(dataAfter.qtyFilled);
                if (dataAfter.qtyFilled >= dataAfter.qtyNeed) {
                    recentItemNeedIncrement = -1;
                } else {
                    recentItemNeedIncrement = 1;
                }
            }

            if (dataAfter.qtyFilled >= dataAfter.qtyNeed) {
                itemComplete = FieldValue.arrayUnion(itemName);
            } else {
                itemNeed = FieldValue.arrayUnion(itemName);
            }
        }

        batchStats.set(itemRef, {name: itemName}, {merge: true});
        batchStats.update(itemRef, {
            qtyNeed: needIncrement,
            qtyFilled: fillIncrement
        });

        if (userRef) {
            batchRequest.update(requestRef, {
                complete: itemComplete,
                active: itemNeed,
            });
            batchUser.update(userRef, {
                [`_recentNeededItems.${itemName}`]: admin.firestore.FieldValue.increment(recentItemNeedIncrement)
            });
        }

        // update itemsByUsers in stats
        // read first to avoid write
        if (itemName && !DEFAULT_REQUEST_ITEMS.includes(itemName)) {
            const recentItemSnapshot = await statsRef.get();
            const recentItemData = recentItemSnapshot.data() as RequestStats;
            if (recentItemData) {
                if (!recentItemData.itemsByUsers.includes(itemName)) {
                    batchStats.update(statsRef, {
                        itemsByUsers: FieldValue.arrayUnion(itemName)
                    });
                }
            }
        }

        return Promise.all([
            batchStats.commit(),
            batchRequest.commit(),
            batchUser.commit()
        ]).then(() => {
            console.info('ok');
            return true;
        }).catch(e => {
            console.error(e);
            return false;
        });
    });

exports.messageOnCreate = functions.region(regionName).firestore
    .document(`${MESSAGES}/{messageId}`)
    .onCreate(async (snapshot, context) => {
        const firestore = admin.firestore();
        const batch = firestore.batch();

        const messageData = snapshot.data() as MessageDocument;

        if (messageData) {
            const requestSnapshot = await firestore.collection(REQUESTS).doc(messageData.requestId).get();
            const requestData = requestSnapshot.data() as Request;
            if (requestData) {
                batch.update(snapshot.ref, {
                    receiverId: requestData.user
                });
            }
        }

        return Promise.all([batch.commit()])
            .then(() => {
                return true;
            })
            .catch(e => {
                console.error(e);
                return false;
            });
    });
