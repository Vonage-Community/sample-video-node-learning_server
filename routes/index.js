import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import _ from 'lodash';
import { uniqueNamesGenerator, adjectives, colors, animals } from 'unique-names-generator';
import { Connect, Conversation, NCCOBuilder, Talk } from '@vonage/voice';
import fetch from 'node-fetch';
import { tokenGenerate } from '@vonage/jwt';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

const appId = process.env.API_APPLICATION_ID;
let privateKey;

if (process.env.PRIVATE_KEY) {
  try {
      privateKey = fs.readFileSync(process.env.PRIVATE_KEY, 'utf8');
  } catch (error) {
      // PRIVATE_KEY entered as a single line string
      privateKey = process.env.PRIVATE_KEY.replace(/\\n/g, '\n');
  }
} else if (process.env.PRIVATE_KEY64){
  privateKey = Buffer.from(process.env.PRIVATE_KEY64, 'base64');
}

if (!appId || !privateKey) {
  console.error('=========================================================================================================');
  console.error('');
  console.error('Missing Vonage Application ID and/or Vonage Private key');
  console.error('Find the appropriate values for these by logging into your Vonage Dashboard at: https://dashboard.nexmo.com/applications');
  console.error('Then add them to ', path.resolve('.env'), 'or as environment variables' );
  console.error('');
  console.error('=========================================================================================================');
  process.exit();
}

import { Vonage } from '@vonage/server-sdk';
import { Video } from '@vonage/video';
const vonageCredentials = {
  applicationId: appId,
  privateKey: privateKey
};
const vonage = new Vonage(vonageCredentials);
vonage.video = new Video(vonageCredentials);

// IMPORTANT: roomToSessionIdDictionary is a variable that associates room names with unique
// session IDs. However, since this is stored in memory, restarting your server will
// reset these values if you want to have a room-to-session association in your production
// application you should consider a more persistent storage

let roomToSessionIdDictionary = {};
let broadcastsToSessionIdDictionary = {};
let sipConversationToSessionIdDictionary = {};

// returns the room name, given a session ID that was associated with it
function findRoomFromSessionId(sessionId) {
  return _.findKey(roomToSessionIdDictionary, function (value) { return value === sessionId; });
}

function findSessionIdForRoom(roomName) {
  return roomToSessionIdDictionary[roomName] ? roomToSessionIdDictionary[roomName] : null;
}

function findConversationFromSessionId(sessionId) {
  return sipConversationToSessionIdDictionary[sessionId];
}

function generatePin() {
  return Math.floor(Math.random() * 9000) + 1000;
};

function generateConversationName() {
  return uniqueNamesGenerator({
    dictionaries: [adjectives, colors, animals]
  });
}

// Creates a session with various roles and properties
async function createSession(response, roomName, sessionProperties = {}, role = 'moderator') {
  let sessionId;
  let token;
  console.log(`Creating ${role} creds for ${roomName}`);

  if (roomToSessionIdDictionary[roomName]) {
    sessionId = roomToSessionIdDictionary[roomName];
    token = vonage.video.generateClientToken(sessionId, { role })
    response.setHeader('Content-Type', 'application/json');
    response.send({
      applicationId: appId,
      sessionId: sessionId,
      token: token
    });
  } else {
    try {
      const session = await vonage.video.createSession(sessionProperties);

      // now that the room name has a session associated wit it, store it in memory
      // IMPORTANT: Because this is stored in memory, restarting your server will reset these values
      // if you want to store a room-to-session association in your production application
      // you should use a more persistent storage for them
      roomToSessionIdDictionary[roomName] = session.sessionId;

      // generate token
      token = vonage.video.generateClientToken(session.sessionId, { role });
      response.setHeader('Content-Type', 'application/json');
      response.send({
        applicationId: appId,
        sessionId: session.sessionId,
        token: token
      });
    } catch(error) {
      console.error("Error creating session: ", error);
      response.status(500).send({ error: 'createSession error:' + error });
    }
  }
}

router.get('/', function (req, res) {
  res.render('index', { title: 'Learning-Vonage-Node' });
});

router.get('/broadcast/:name/host', async function (req, res) {
  const broadcastName = req.params.name + '-broadcast';
  await createSession(res, broadcastName, { initialLayoutClassList: ['full', 'focus'] }, 'moderator');
});

router.get('/broadcast/:name/viewer', async function (req, res) {
  const broadcastName = req.params.name + '-broadcast';
  await createSession(res, broadcastName, { initialLayoutClassList: ['full', 'focus'] }, 'subscriber');
});

router.get('/broadcast/:name/guest', async function (req, res) {
  const broadcastName = req.params.name + '-broadcast';
  await createSession(res, broadcastName, { initialLayoutClassList: ['full', 'focus'] }, 'subscriber');
});

router.post('/broadcast/:room/start', async (req, res) => {
  const { rtmp, lowLatency, fhd, dvr, sessionId, streamMode } = req.body;
  // Kill any existing broadcasts we have, to be safe
  vonage.video.searchBroadcasts({sessionId})
    .then(list => {
      list.items.map(async (broadcast) => {
        vonage.video.stopBroadcast(broadcast.id)
      })
    })

  vonage.video.startBroadcast(sessionId, {outputs: {rtmp, hls: {lowLatency, dvr}}, streamMode})
    .then(data => {
      broadcastsToSessionIdDictionary[sessionId] = data;
      res.send(data)
    })
    .catch(error => {
      console.error(error);
      res.status(500).send(error)
    })
})

router.post('/broadcast/:room/stop', async (req, res) => {
  const { sessionId } = req.body
  if (broadcastsToSessionIdDictionary[sessionId]) {
    vonage.video.stopBroadcast(broadcastsToSessionIdDictionary[sessionId].id)
      .then(data => {
        delete broadcastsToSessionIdDictionary[sessionId]
        res.send(data)
      })
      .catch(err => {
        console.error(err)
        res.status(500).send(err)
      })
  }
})

router.post('/broadcast/:room/status', async (req, res) => {
  const { sessionId } = req.body
  if (broadcastsToSessionIdDictionary[sessionId]) {
    vonage.video.getBroadcast(broadcastsToSessionIdDictionary[sessionId].id)
      .then(data => {
        res.send(data)
      })
      .catch(err => {
        console.error(err)
        res.status(500).send(err)
      })
  }
})

/**
 * GET /session redirects to /room/session
 */
router.get('/session', function (req, res) {
  res.redirect('/room/session');
});

/**
 * GET /room/:name
 */
router.get('/room/:name', async function (req, res) {
  const roomName = req.params.name;
  const e2ee = req.params.e2ee || false
  await createSession(res, roomName, { mediaMode:"routed", e2ee }, 'moderator');
});

/**
 * POST /archive/start
 */
router.post('/archive/start', async function (req, res) {
  console.log('attempting to start archive');
  const json = req.body;
  const sessionId = json.sessionId;
    const archiveOptions = {
    name: findRoomFromSessionId(sessionId),
  };
  if (json.outputMode){
    archiveOptions.outputMode = json.outputMode;
  };
  if (json.hasTranscription){
    archiveOptions.hasTranscription = json.hasTranscription;
  };
  try {
    const archive = await vonage.video.startArchive(sessionId, archiveOptions);
    console.log("archive: ", archive);
    res.setHeader('Content-Type', 'application/json');
    res.send(archive);
  } catch (error){
    console.error("error starting archive: ",error);
    res.status(500).send({ error: 'startArchive error:' + error });
  }
});

/**
 * POST /archive/:archiveId/stop
 */
router.post('/archive/:archiveId/stop', async function (req, res) {
  const archiveId = req.params.archiveId;
  console.log('attempting to stop archive: ' + archiveId);
  try {
    const archive = await vonage.video.stopArchive(archiveId);
    res.setHeader('Content-Type', 'application/json');
    res.send(archive);
  } catch (error){
    console.error("error stopping archive: ",error);
    res.status(500).send({ error: 'stopArchive error:', error });
  }
});

/**
 * GET /archive/:archiveId/view
 */
router.get('/archive/:archiveId/view', async function (req, res) {
  const archiveId = req.params.archiveId;
  console.log('attempting to view archive: ' + archiveId);
  try {
    const archive = await vonage.video.getArchive(archiveId);
    if (archive.status === 'available') {
      res.redirect(archive.url);
    } else {
      res.render('view', { title: 'Archiving Pending' });
    }
  } catch (error){
    console.log("error viewing archive: ",error);
    res.status(500).send({ error: 'viewArchive error:' + error });
  }
});

/**
 * GET /archive/:archiveId
 */
router.get('/archive/:archiveId', async function (req, res) {
  const archiveId = req.params.archiveId;
  // fetch archive
  console.log('attempting to fetch archive: ' + archiveId);
  try {
    const archive = await vonage.video.getArchive(archiveId);
    // extract as a JSON object
    res.setHeader('Content-Type', 'application/json');
    res.send(archive);
  } catch (error){
    console.error("error getting archive: ",error);
    res.status(500).send({ error: 'getArchive error:' + error });
  }
});

/**
 * GET /archive
 */
router.get('/archive', async function (req, res) {
  let filter = {};
  if (req.query.count) {
    filter.count = req.query.count;
  }
  if (req.query.offset) {
    filter.offset = req.query.offset;
  }
  if (req.query.sessionId) {
    filter.sessionId = req.query.sessionId;
  }
  // list archives
  console.log('attempting to list archives');
  try {
    const archives = await vonage.video.searchArchives(filter);
    // extract as a JSON object
    res.setHeader('Content-Type', 'application/json');
    res.send(archives);
  } catch (error){
    console.error("error listing archives: ",error);
    res.status(500).send({ error: 'listArchives error:' + error });
  }
});

router.get("/sip/:room", async function (req, res) {
  const sessionId = findSessionIdForRoom(req.params.room);
  if (sessionId) {
    const conversation = findConversationFromSessionId(sessionId);
    if (conversation) {
      res.send(conversation);
      return;
    } else {
      sipConversationToSessionIdDictionary[sessionId] = {
        pin: generatePin(),
        conversationName: generateConversationName(),
        sessionId,
        conferenceNumber: process.env.CONFERENCE_NUMBER
      }

      res.send(sipConversationToSessionIdDictionary[sessionId]);
    }
  } else {
    res.status(404).send({
      title: "Unknown room",
      details: "The room you requested does not exist, therefore we have no SIP information"
    });
  }
});

router.post("/sip/:room/dial", async function (req, res) {
  const { msisdn } = req.body;
  const sessionId = findSessionIdForRoom(req.params.room);
  const conversation = findConversationFromSessionId(sessionId);
  const token = vonage.video.generateClientToken(sessionId, {
    data: JSON.stringify({
      sip: true,
      role: 'client',
      name: conversation.conversationName,
    })
  })

  const options = {
    token, 
    sip: {
      auth: {
        username: process.env.VCR_API_ACCOUNT_ID,
        password: process.env.VCR_API_ACCOUNT_SECRET,
      },
      uri: `sip:${process.env.CONFERENCE_NUMBER}@sip.nexmo.com;transport=tls`,
      secure: false,
    }
  }

  if (msisdn) {
    options.sip.headers = {
      "X-learningserver-msisdn": msisdn
    }
  }

  await vonage.video.intiateSIPCall(sessionId, options)
    .then(data => {
      // Update the conversation with connection data
      conversation.connectionId = data.connectionId;
      conversation.streamId = data.streamId;
      sipConversationToSessionIdDictionary[sessionId] = conversation;

      res.send(data)
    })
});

router.post("/sip/:room/hangup", async function (req, res) {
  // Get the session ID
  // Look up the connection from calls ID
  const sessionId = findSessionIdForRoom(req.params.room)
  const conversation = findConversationFromSessionId(sessionId);
  await vonage.video.disconnectClient(sessionId, conversation.connectionId)
    .then(data => 
      res.send(data)
    )
    .catch(error => res.status(500).send(error));
});

router.get('/sip/vapi/answer', async function (req, res) {
  const ncco = new NCCOBuilder();
  const conversation = findConversationFromSessionId(findSessionIdForRoom('session'));

  // If the call is not from the SIP connector, then announce we are connecting
  // to the conference call
  if (!req.query['SipHeader_X-OpenTok-SessionId']) {
    ncco.addAction(new Talk('Please wait while we connect you'));
  }

  // Call an individual user
  if (req.query['SipHeader_X-learningserver-msisdn']) {
    ncco.addAction(new Connect({type: 'phone', number: req.query['SipHeader_X-learningserver-msisdn']}, process.env.CONFERENCE_NUMBER));
  } else {
    ncco.addAction(new Conversation(conversation.conversationName, null, true, true, false, null, null, false));
  }

  res.send(ncco.build());
});

// This must be all because VAPI sometimes sends events as POST no matter what
// your event URL config is set to. This is a known bug.
router.all('/sip/vapi/events', async function (req, res) {
  if (req.query.status === "completed") {
    const conversation = findConversationFromSessionId(findSessionIdForRoom('session'));
    await vonage.video.disconnectClient(findSessionIdForRoom('session'), conversation.connectionId)
      .then(data => res.send(data))
      .catch(error => res.status(500).send(error));
  } else {
    res.send();
  }
})

router.all('/admin/clear-conversations', async function (req, res) {
  const token = tokenGenerate(appId, privateKey);
  await fetch('https://api.nexmo.com/v0.3/conversations', {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  })
    .then(res => res.json())
    .then(async (data) => {
      for (i in data._embedded.conversations) {
        const convo = data._embedded.conversations[i];
        await fetch(convo._links.self.href, {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          }
        })
          .catch(error => console.error(error));
      }
      res.send({status: true, message: 'Cleared all conversations'});
    })
    .catch(error => {
      console.error(error);
      res.send(error)
    });
});

/**
 * POST /captions/start
 */
router.post('/captions/start', async (req, res) => {
  const sessionId = req.body.sessionId;
  const captionsOptions = {
    languageCode: 'en-US',
    partialCaptions: 'true',
  };
  try {
    const captionsResponse = await vonage.video.enableCaptions(sessionId, req.body.token, captionsOptions);
    const captionsId = captionsResponse.captionsId;
    res.send({ id: captionsId });
  } catch (error) {
    console.error("Error starting captions: ",error);
    res.status(500).send(`Error starting captions: ${error}`);
  }
});

/**
 * POST /captions/:captionsId/stop
 */
router.post('/captions/:captionsId/stop', async (req, res) => {
  const captionsId = req.params.captionsId;
  try {
    await vonage.video.disableCaptions(captionsId);
    res.sendStatus(202)
  } catch (error) {
    console.error("Error stopping captions: ",error);
    res.status(500).send(`Error stopping captions: ${error}`);
  }
});

/**
 * POST /audio-connector/connect
 */
router.post('/audio-connector/connect', async (req, res) => {
  const { webSocketHost, sessionId } = req.body;
  try {
    const token = tokenGenerate(appId, privateKey);
    const webSocketToken = vonage.video.generateClientToken(sessionId, { role: 'publisher' });
    const audioConnectorResponse = await fetch(`https://video.api.vonage.com/v2/project/${appId}/connect`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        "sessionId": sessionId,
        "token": webSocketToken,
        "websocket": {
          "uri": `wss://${webSocketHost}`,
          "audioRate": 16000,
          "bidirectional": true
        }
      })
    })
    const audioConnectorResponseJson = await audioConnectorResponse.json();
    res.send(audioConnectorResponseJson);
  } catch (error) {
    console.error("Error starting Audio Connector: ",error);
    res.status(500).send(`Error starting Audio Connector: ${error}`);
  }
});

/**
 * POST /audio-connector/disconnect
 */
router.post('/audio-connector/disconnect', async (req, res) => {
  const { sessionId, connectionId } = req.body;
  try {
    await vonage.video.disconnectClient(sessionId, connectionId);
    console.log("Successfully disconnected Audio Connector");
    res.sendStatus(204)
  } catch (error) {
    console.error("Error starting Audio Connector: ",error);
    res.status(500).send(`Error stopping Audio Connector: ${error}`);
  }
});

router.get('/_/health', async function (req, res) {
  res.status(200).send({status: 'OK'});
})

export default router;
