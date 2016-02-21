var xmpp_client = require('node-xmpp-client');
var ltx = require('ltx');
var helper = require('./ltxhelper.js');
var config = require('./config.js');


/**
 * only include devices in the data structure that have useful state
 * this list may be incomplete, as I don't have every device
 * 1013: Sensor/ Jalousieaktor 1/1-fach
 * 9004: Raumtemperaturregler
 * 100E: Sensor/ Schaltaktor 2/1-fach
 * 101C: Dimmaktor 4-fach
 * B002: Schaltaktor 4-fach, 16A, REG
 * B003: Heizungsaktor 6-fach, REG
 * B001: Jalousieaktor 4-fach, REG
 */
var withStatus = ['1013', '9004', '100E', '101C', 'B002', 'B003', 'B001'];


/**
 * construct and sends a request for the master update
 */
var all = function () {
	var allData = new xmpp_client.Element('iq', {
		type: 'set',
		to: 'mrha@busch-jaeger.de/rpc',
	})
		.c('query', {
			xmlns: 'jabber:iq:rpc'
		})
			.c('methodCall', {})
				.c('methodName', {})
					.t('RemoteInterface.getAll').up()
				.c('params', {})
					.c('param', {})
						.c('value', {})
							.c('string', {})
								.t('de')
								.up()
							.up()
						.up()
					.c('param', {})
						.c('value', {})
							.c('int', {})
								.t('4')
								.up()
							.up()
						.up()
					.c('param', {})
						.c('value', {})
							.c('int', {})
								.t('0')
								.up()
							.up()
						.up()
					.c('param', {})
						.c('value', {})
							.c('int', {})
								.t('0');
	
	module.parent.exports.sysap.send(allData);
	console.log('[OUT] get master update');
}

/**
 * parses a presence packet and logs the info
 * @param {Object} stanza - a node-xmpp-client xml data packet
 */
var presence = function (stanza) {
	
	var from = helper.getAttr(stanza, 'from');
	
	if (from) {
		if (from == config.bosh.jid + '/' + config.bosh.resource) {
			console.log('[SYSAP] myself present');
		} else if (from == 'mrha@busch-jaeger.de/rpc') {
			console.log('[SYSAP] sysap present');
		} else {
			console.log('[SYSAP] unknown user present: ' + from);
		}
	} else {
		console.log('[SYSAP] unknown presence packet');
	}
	
}

/**
 * parses an update packet and updates the master data structure
 * requires a pre-populated actuators object
 * @param {Object} stanza - a node-xmpp-client xml data packet
 */
var update = function (stanza, data) {

	helper.getElements(stanza, ['event', 'items', 'item']).forEach(function (item) {
		
		// parse payload
		// no XML verification, let's hope that Busch Jäger produces writes valid XML in this case
		var update = ltx.parse(helper.getElementText(item, ['update', 'data']));
		
		if (update) { 
			console.log('[SYSAP] update');
			helper.getElements(update, ['devices', 'device']).forEach(function (device) {
				
				// is a valid device and init is completed
				var sn = helper.getAttr(device, 'serialNumber');
				if (sn && sn != '' && data.actuators[sn]) {
				
					// valid update packet that is of interest
					if (helper.getAttr(device, 'commissioningState') == 'ready') {
						
						// iterate over all channels and datapoints
						helper.getElements(device, ['channels', 'channel']).forEach(function (channel) {
							var cn = helper.getAttr(channel, 'i');
							if (cn) {
								channel.children.forEach(function (dp) {
									if (!data.actuators[sn]['channels'][cn]) {
										data.actuators[sn]['channels'][cn] = {
											datapoints: {}
										};
									}
									dp.getChildren('dataPoint').forEach(function (datapoint) {
										var pt = helper.getAttr(datapoint, 'i');
										var vl = helper.getElementText(datapoint, ['value']);
										if (pt && vl) {
											data.actuators[sn].channels[cn].datapoints[pt] = vl;
										}
									});
								});
							}
						});
					}
				}
			});
		}
	});
}

/**
 * parses the master packet and creates the master data struchture
 * @param {Object} stanza - a node-xmpp-client xml data packet
 */
var response = function (stanza, data) {
	helper.getElements(stanza, ['query', 'methodResponse', 'params', 'param']).forEach(function (param) {
		
		helper.getElements(param, ['value', 'boolean']).forEach(function (value) {
			var result = value.getText();
			if (result == 1) {
				console.log('[SYSAP] result update succes');
			} else if (result == 0) {
				console.log('[SYSAP] result update failure');
			} else {
				console.log('[SYSAP] result update unknown: ' + result);
			}
		});
		
		helper.getElements(param, ['value', 'int']).forEach(function (value) {
				console.log('[SYSAP] unknown int update:');
				console.log(stanza.toString());
		});
		
		helper.getElements(param, ['value', 'string']).forEach(function (value) {
			
			var allDataText = value.getText();

			if (allDataText.length > 10240) {
				console.log('[SYSAP] master update');
				
				// valid XML is not necessary for all parsers, but it helps (and ltx is small and fast BECAUSE it doesn't accept shitty XML)
				allDataText = allDataText.replace('<Channel selector OR>', '&lt;Channel selector OR&gt;');
				allDataText = allDataText.replace('<Channel selector AND>', '&lt;Channel selector AND&gt;');
				allDataText = allDataText.replace('<The following strings from F000 to FFFF are not to be translated!>', '&lt;The following strings from F000 to FFFF are not to be translated!&gt;');
				var allData = ltx.parse(allDataText);
			
				// floors and rooms
				helper.getElements(allData, ['entities', 'entity']).forEach(function (entity) {
					var entityData = JSON.parse(entity.getText());
					if (entity.attrs.type == 'floor' || entity.attrs.type == 'room') {
						data.house[entity.attrs.type][entity.attrs.uid] = entityData.name;
					}
				});
			
				// strings
				helper.getElements(allData, ['strings', 'string']).forEach(function (string) {
					data.strings[string.attrs.nameId] = string.getText();
				});
			
				// actuators
				helper.getElements(allData, ['devices', 'device']).forEach(function (device) {
				
					var sn = helper.getAttr(device, 'serialNumber');
					var deviceId = helper.getAttr(device, 'deviceId');
					if (sn && withStatus.indexOf(deviceId) != -1) {
						var nameId = helper.getAttr(device, 'nameId');
						data.actuators[sn] = {
							serialNumber: sn,
							deviceId: deviceId,
							typeName: data.strings[nameId],
							channels: {}
						};
						helper.getElements(device, ['channels', 'channel']).forEach(function (channel) {
							var cn = helper.getAttr(channel, 'i');
							if (cn) {
								data.actuators[sn]['channels'][cn] = {
									datapoints: {}
								};
								['inputs', 'outputs'].forEach(function (put) {
									helper.getElements(channel, [put, 'dataPoint']).forEach(function (dataPoint) {
										var dp = helper.getAttr(dataPoint, 'i');
										if (dp) {
											data.actuators[sn]['channels'][cn]['datapoints'][dp] = helper.getElementText(dataPoint, ['value']);
										}
									});
								});
							}
						});
					}
				});
			} else {
				console.log('[SYSAP] unknown string update:');
				console.log(stanza.toString());
			}
		});
	});
}


module.exports.all = all;
module.exports.presence = presence;
module.exports.update = update;
module.exports.response = response;