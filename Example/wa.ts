import {
    WAConnection,
    MessageType,
    Presence,
    MessageOptions,
    Mimetype,
    WALocationMessage,
    MessageLogLevel,
    WA_MESSAGE_STUB_TYPES,
    ReconnectMode,
} from '../src/WAConnection/WAConnection'
import * as fs from 'fs'

const simulation = true

const mysql = require('mysql');
const config = require('../config.json')
let sqlConnection
const waConnection = new WAConnection() 

// message send
// settings moved to config.json

const g_message: string = config.message
const g_adminIds = config.adminIds
const g_adminPhones = config.adminPhones
const g_groupName: string = config.groupName
const gs_groupId: number = config.gs_groupId
const gs_waGroupId: string = config.gs_waGroupId
const g_cohortId: number = 2
const g_processMax: number = 1

let g_messageId: number

function cleanupSendMessage() {
    console.log('FATAL: in cleanupSendMessage')
}

async function sendMessage() {
    // 1 add message to messages table, if not already there
    // 2 pick user not in cohort already, add to user_cohort
    // 3 create WA group and add to grps table
    // 4 add user to user_group table
    // 5 add to user_message table
    // 6 send message
    // 7 update user_message

    // handle the fact that phone numbers are not unique: made users.cell_num unique
    // TODO: run for 2 users

    const query = `insert ignore into messages (content, cohort_id) values ("${g_message}", ${g_cohortId})`
    sqlConnection.query(query, function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        //console.log('affected ' + results.affectedRows + ' rows');
        g_messageId = results.insertId
        sm2_pickUser()
    });    
}

function sm2_pickUser() {
    //console.log("in pickUser: ")
    let query
    if (simulation) {
        query = `select id, cell_num from users where is_test = 1 limit 1`
    } else {
        query = `select id, cell_num from users where is_admin = 0 AND optout_time is null AND exists_on_wa = 1 AND id not in (select user_id from user_cohort where cohort_id = ${g_cohortId}) limit 1`
    }
    sqlConnection.query(query, function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        if (results.length > 0) {
            console.log(`picked user with id = ${results[0].id} and phone = ${results[0].cell_num}`)
            sm22_userCohort(results[0].id, results[0].cell_num)
        } else {
            console.log('ERROR in pickUser: no rows found')
            cleanupSendMessage()
        }
    });
}

function sm22_userCohort(userId, cellNum) {
    const query = `insert ignore into user_cohort (user_id, cohort_id) values (${userId}, ${g_cohortId})`
    sqlConnection.query(query, function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        //console.log('affected ' + results.affectedRows + ' rows');
        sm3_createGroup(userId, cellNum)
    });
}

async function sm3_createGroup(userId, cellNum) {
    //console.log('in createGroup: ', messageId, userId, cellNum)

    // add the 3 users, 1 + 2 admins
    let users = [cellNum]
    users = users.concat(g_adminPhones)
    users = users.map(user => convertPhoneToWAUserId(user))
    //console.log('creating group with users: ', users)
    
    // instead of creating a new one, first see if one already exists with the desired group name and users
    let group
    if (simulation) {
        sm4_addUserGroups(userId, gs_waGroupId, gs_groupId)
        return
    }
    console.log('creating WA group')
    group = await waConnection.groupCreate(g_groupName, users)
    console.log('created WA group')
    const query = "insert ignore into `groups` (name, wa_id) values (?, ?)"
    sqlConnection.query(query, [g_groupName, group.gid], function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        //console.log('affected ' + results.affectedRows + ' rows');
        sm4_addUserGroups(userId, group.gid, results.insertId)
    });
}

function sm4_addUserGroups(userId, waGroupId, groupId) {
    //console.log('in sm4_addUserGroups: ', waGroupId, groupId)

    let query = `insert ignore into user_group (user_id, group_id) values (${userId}, ${groupId})`
    g_adminIds.forEach(adminId => query += `, (${adminId}, ${groupId})`)
    //console.log(query)
    sqlConnection.query(query, function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        //console.log('affected ' + results.affectedRows + ' rows');
        sm5_addUserMessages(userId, waGroupId, groupId)
    });
}

function sm5_addUserMessages(userId, waGroupId, groupId) {
    //console.log('in addUserMessage', userId, messageId)
    let query
    if (g_messageId == 0) {
        query = `insert ignore into user_message (sent_time, user_id, group_id, message_id) values (now(), ${userId}, ${groupId}, (select id from messages where content = "${g_message}" and cohort_id = ${g_cohortId})) on duplicate key update sent_time = now()`
    } else {
        query = `insert ignore into user_message (sent_time, user_id, message_id, group_id) values (now(), ${userId}, ${g_messageId}, ${groupId}) on duplicate key update sent_time = now()`
    }
    //console.log(query)
    sqlConnection.query(query, async function(error, results, fields) {
        if (error) {
            cleanupSendMessage()
            throw error;
        }
        //console.log('affected ' + results.affectedRows + ' rows');
        await waConnection.sendMessage(waGroupId, g_message, MessageType.text)
        console.log('message sent!')
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function connectToDb() {
    sqlConnection = mysql.createConnection({
        host     : config.host,
        user     : config.user,
        password : config.password,
        database : config.database
    });
    sqlConnection.connect(function(err) {
        if (err) {
            console.error('error connecting: ' + err.stack);
            return;
        }
        console.log('connected as id ' + sqlConnection.threadId);
    });
    await connectToWhatsApp().catch (err => console.log("unexpected error: " + err) ) // catch any errors
}

function cleanup() {
    console.log('In cleanup')
    sqlConnection.end(function(error) {
        if (error)
            console.log('FATAL ERROR closing mysql connection')
    });
}


function e4_saveExists(phone, exists) {
    //console.log('in saveExists: ', phone)
    let query

    if (exists) {
        query = 'update users set exists_on_wa = 1, exists_on_wa_check_time = now() where cell_num = ?'
    } else {
        query = 'update users set exists_on_wa = 0, exists_on_wa_check_time = now() where cell_num = ?'
    }

    //console.log('query: ', query)
    sqlConnection.query(query, [phone], function(error, results, fields) {
        if (error) throw error;
        console.log('changed ' + results.changedRows + ' rows');
    });    
}

function convertPhoneToWAUserId(phone) {
    let newPhone = phone.replace('(', '').replace(')', '').replace(' ', '').replace('-', '')
    newPhone = '1' + newPhone
    if (newPhone.length != 11) {
        console.log('ERROR: bad phone: ', newPhone)
        return
    }
    return newPhone + '@s.whatsapp.net'
 }

async function e3_validatePhone(phone) {
    //console.log('In validatePhone: ', phone)
    const newid = convertPhoneToWAUserId(phone)

    //console.log('checking for: ', newid)
    const exists = await waConnection.isOnWhatsApp (newid)
    console.log (`${newid} ${exists ? " exists " : " does not exist"} on WhatsApp`)

    // save result back in db
    e4_saveExists(phone, exists)
}


// query db and get one phone number 
function e2_processExists() {
    // console.log('In processExists')

    const query = 'select cell_num as num from users where exists_on_wa is null limit 1'
    sqlConnection.query(query, function (error, results, fields) {
        if (error) throw error;
        //console.log('Returning number: ', results[0].num);
        if (results.length > 0)
            e3_validatePhone(results[0].num)
        else {
            console.log('ERROR: no rows found')
        }
    });
}

async function e1_determineMaxAndLoop() {
    const query = 'select count(distinct(cell_num)) as num from users where exists_on_wa is null'

    sqlConnection.query(query, async function(error, results, fields) {
        if (error) throw error;
        //console.log('Returning number: ', results[0].num);
        if (results.length > 0 && results[0].num > 0) {
            let numToProcess = Math.min(results[0].num, g_processMax)
            console.log('*** Processing rows = ', numToProcess)

            for (let i = 0; i < numToProcess; i++) {
                console.log('***', i+1, ' of ', numToProcess)
                e2_processExists()
                await sleep(1000)
            }

            cleanup()

        } else {
            console.log('ERROR: no rows found: ', results.length)
        }
    });
}

async function connectToWhatsApp() {
    
    //console.log('1')
    waConnection.autoReconnect = ReconnectMode.onConnectionLost // only automatically reconnect when the connection breaks
    waConnection.logLevel = MessageLogLevel.info // set to unhandled to see what kind of stuff you can implement

    // loads the auth file credentials if present
    fs.existsSync('./auth_info.json') && waConnection.loadAuthInfo ('./auth_info.json')
    
    /* Called when contacts are received, 
     * do note, that this method may be called before the connection is done completely because WA is funny sometimes 
     * */
    //waConnection.on ('contacts-received', contacts => console.log(`received ${Object.keys(contacts).length} contacts`))
    
    // connect or timeout in 60 seconds
    await waConnection.connect()

    const authInfo = waConnection.base64EncodedAuthInfo() // get all the auth info we need to restore this session
    fs.writeFileSync('./auth_info.json', JSON.stringify(authInfo, null, '\t')) // save this info to a file

    if (simulation) {
        console.log("*** Running in SIMULATION mode")        
    } else {
        console.log("*** Running for REAL!")
    }

    console.log ("oh hello " + waConnection.user.name + " (" + waConnection.user.jid + ")")
    console.log ("you have " + waConnection.chats.all().length + " chats")
    console.log()

    // exists flow: determine max and loop
    // await e1_determineMaxAndLoop()

    // message send flow
    for (let i = 0; i < g_processMax; i++) {
        console.log('***', i+1, ' of ', g_processMax)
        await sendMessage()
        await sleep(1000)
    }

}

function updateMessageStatus(message) {
    // handle case where FROM is not from a group AND TO is to a group
    const from = message.from + ''
    const to = message.to + ''
    let user = message.participant + ''
    user = user.replace('@c.us', '').substr(1)
    console.log('*** from user: ', user)
    if (from.includes('@c') && to.includes('@g')) {
        console.log('in updateMessageStatus')
        const waGroupId = to
        let field: string
        if (message.type == 3) {
            field = 'deliver_time'
        } else if (message.type == 4) {
            field = 'read_time'
        } else {
            return
        }

        let query: string
        if (g_messageId == 0) {
            query = `update user_message set ${field} = now() where message_id in (select id from messages where content = "${g_message}" and cohort_id = ${g_cohortId}) AND user_id in (select id from users where normalized_cell = "${user}")`
        } else {
            query = `update user_message set ${field} = now() where message_id = ${g_messageId} AND user_id in (select id from users where normalized_cell = "${user}")`
        }    
        console.log(query)
        sqlConnection.query(query, function(error, results, fields) {
            if (error) {
                cleanupSendMessage()
                throw error;
            }
            console.log('affected ' + results.affectedRows + ' rows');
        });
        
    }
}

function listen() {
    waConnection.on('message-status-update', (message) => {
        console.log ('from: ', message.from)
        console.log ('to: ', message.to, message.ids)
        console.log ('type: ', message.type, message.participant)
        updateMessageStatus(message)
    })

    // no way to differentiate between user exiting themselves and admin removing them
    // we will assume user quit
    // TODO: is user quit same as STOP?
    waConnection.on ('group-participants-remove', (update) => {
        console.log ('jid: ', update.jid)
        console.log ('participants: ', update.participants)
        // : {jid: string, participants: string[], actor?: string}
    })

}

listen()
// run in main file
connectToDb() //.catch (err => console.log("unexpected error: " + err) ) // catch any errors
