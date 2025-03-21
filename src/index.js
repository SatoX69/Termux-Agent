const util = require('util');
const exec = util.promisify(require('child_process').exec);
const fs = require('fs');
const xml2js = require('xml2js');
const readline = require('readline');
const Groq = require('groq-sdk');
const log = console.log;
const groq = new Groq({ apiKey: process.env['GROQ_API_KEY'] });

async function executeAdbCommand(command) {
  try {
    const { stdout } = await exec(`adb ${command}`);
    return stdout.trim();
  } catch (error) {
    throw new Error(`ADB command failed: ${error.message}`);
  }
}

async function tap(x, y) {
  await executeAdbCommand(`shell input tap ${x} ${y}`);
  log(`Tapped at (${x}, ${y}).`);
}

async function inputText(text) {
  const escapedText = text.replace(/ /g, '%s');
  await executeAdbCommand(`shell input text ${escapedText}`);
  log(`Input text "${text}".`);
}

async function swipe(fromX, fromY, toX, toY, duration) {
  await executeAdbCommand(`shell input swipe ${fromX} ${fromY} ${toX} ${toY} ${duration}`);
  log(`Swiped from (${fromX}, ${fromY}) to (${toX}, ${toY}) over ${duration}ms.`);
}

async function getAllPackages() {
  const stdout = await executeAdbCommand('shell pm list packages');
  return stdout.split('\n')
    .map(line => line.replace('package:', '').trim())
    .filter(Boolean)
    .join(', ');
}

async function getScreenSize() {
  const stdout = await executeAdbCommand('shell wm size');
  const match = stdout.match(/Physical size: (\d+)x(\d+)/);
  if (!match) throw new Error('Unable to get screen size.');
  return { width: parseInt(match[1]), height: parseInt(match[2]) };
}

async function checkAdbConnection() {
  try {
    const stdout = await executeAdbCommand('devices');
    const devices = stdout.split('\n').filter(line => line.trim().endsWith('device'));
    if (devices.length === 0) {
      throw new Error('No devices found. Ensure the device is connected and authorized.');
    }
    log('ADB connection verified.');
  } catch (error) {
    throw new Error(`ADB connection failed: ${error.message}`);
  }
}

function askGoal() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question('Automate: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function showToast(message) {
  try {
    await exec(`termux-toast -g bottom "${message}"`);
  } catch (err) {
    console.error(err);
  }
}

async function getUiTree() {
  try {
    await executeAdbCommand('shell uiautomator dump /sdcard/ui.xml');
    await executeAdbCommand('pull /sdcard/ui.xml ./ui.xml');
    if (!fs.existsSync('./ui.xml')) {
      throw new Error('Failed to pull ui.xml: file not found');
    }
    const xmlData = fs.readFileSync('./ui.xml', 'utf-8');
    const parser = new xml2js.Parser();
    return await parser.parseStringPromise(xmlData);
  } catch (err) {
    log('UI dump error: ' + err.message);
    return null;
  }
}

function extractUiElements(uiTree) {
  const elements = [];
  
  function traverse(node) {
    if (node.$) {
      const bounds = node.$.bounds || '';
      const match = bounds.match(/(\d+),(\d+)(\d+),(\d+)/);
      if (match) {
        const [_, x1, y1, x2, y2] = match.map(Number);
        elements.push({
          text: node.$.text || '',
          resourceId: node.$['resource-id'] || '',
          class: node.$.class || '',
          x: Math.floor((x1 + x2) / 2),
          y: Math.floor((y1 + y2) / 2),
          width: x2 - x1,
          height: y2 - y1
        });
      }
    }
    for (const key in node) {
      if (Array.isArray(node[key])) node[key].forEach(child => traverse(child));
    }
  }
  if (uiTree && uiTree.hierarchy && uiTree.hierarchy.node) {
    traverse(uiTree.hierarchy.node);
  }
  return elements;
}

async function getContext() {
  const uiTree = await getUiTree();
  if (!uiTree) return 'Unknown';
  const elements = extractUiElements(uiTree);
  return elements.map(e => `${e.text || e.resourceId || e.class} [${e.x},${e.y}]`).join(', ');
}

async function runAgent() {
  const packages = await getAllPackages();
  const conversation = [{
    role: 'system',
    content: 'You are an autonomous Android control agent via ADB in Termux. ' +
      'Your task is to navigate apps using UI interactions (taps, swipes, text input) based on UI element positions and text. ' +
      'Avoid using "shell am start ..." unless no UI path exists. Instead, use a launcher command like "shell monkey -p <package> -c android.intent.category.LAUNCHER 1" when opening an app. ' +
      'Available packages: ' + packages + '. ' +
      'Provide one command per step (max 2 per iteration) in the following format on separate lines:\n' +
      `Command: <without the adb prefix> "shell input tap 500 500" or 'shell input text "hello"'>\n` +
      'Sleep: <duration in seconds>\n' +
      'Read the current UI context before proceeding with gestures. ' +
      'Reply "DONE" when the task is complete. ' +
      'DO NOT INCLUDE ANY ADDITIONAL TEXT. ' +
      'RESPOND WITH "DONE" if no further actions are required or the motive has been satisfied'
  }];
  try {
    await showToast('AI Agent Starting');
    log('Agent starting.');
    await checkAdbConnection();
    const userCommand = await askGoal();
    if (!userCommand) {
      return await showToast('No command provided.');
    }
    conversation.push({ role: 'user', content: userCommand });
    
    /*
        // Go to Homescreen
    await executeAdbCommand('shell input keyevent KEYCODE_HOME');
    await executeAdbCommand('shell input keyevent KEYCODE_HOME');
    log('Navigated to home screen.');
    */
    
    while (true) {
      const context = await getContext();
      conversation.push({ role: 'system', content: 'UI Context: ' + context });
      
      const response = await groq.chat.completions.create({
        model: 'qwen-2.5-32b',
        // Best model for this In my opinion, feel free to play around with other models
        messages: conversation,
        temperature: 0.175,
        // Tweak the temperature to your liking
        max_completion_tokens: 500
        // 50 Recommended but isn't useful for typing stuff.
      });
      const aiOutput = response.choices[0].message.content.trim();
      log('AI output:\n' + aiOutput);
      conversation.push({ role: 'assistant', content: aiOutput });
      
      if (aiOutput.toUpperCase() === 'DONE') {
        await showToast('Execution complete.');
        break;
      }
      
      const lines = aiOutput.split('\n');
      const steps = [];
      let currentStep = null;
      for (let line of lines) {
        const trimmed = line.trim();
        if (trimmed.toUpperCase() === 'DONE') continue;
        if (trimmed.startsWith('Command:')) {
          if (currentStep) steps.push(currentStep);
          currentStep = { primary: trimmed.slice('Command:'.length).trim() };
        } else if (trimmed.startsWith('Sleep:')) {
          if (currentStep) {
            const sleepSec = parseInt(trimmed.slice('Sleep:'.length).trim(), 10);
            currentStep.sleep = sleepSec * 1000;
          }
        }
      }
      if (currentStep) steps.push(currentStep);
      
      for (let step of steps) {
        if (!step.primary) continue;
        step.primary = step.primary.replace(/^adb\s+/, '');
        
        if (step.primary.startsWith('shell input text')) {
          const parts = step.primary.split(' ');
          if (parts.length >= 4) {
            const textArg = parts.slice(3).join(' ');
            const escapedText = textArg.replace(/ /g, '%s');
            step.primary = `shell input text ${escapedText}`;
          }
        }
        
        if (step.primary.startsWith('shell input tap')) {
          const parts = step.primary.split(' ');
          if (parts.length < 4) {
            log('Error: tap command missing coordinates, skipping this step.');
            await showToast('Skipping invalid tap command.');
            continue;
          }
        }
        
        let success = false;
        let ranCmd = step.primary;
        try {
          log(`Executing command: ${step.primary}`);
          await executeAdbCommand(step.primary);
          success = true;
        } catch (err) {
          log(`Primary command failed: ${err.message}`);
        }
        if (!success) {
          await showToast('Command failed: ' + ranCmd);
          return;
        } else {
          await showToast('Executed: ' + ranCmd);
        }
        // Default setTimeout for unexpected delay in processes
        await new Promise(resolve => setTimeout(resolve, 1500));
        if (step.sleep) {
          log(`Sleeping for ${step.sleep}ms`);
          await new Promise(resolve => setTimeout(resolve, step.sleep));
        }
        const newContext = await getContext();
        conversation.push({ role: 'system', content: 'UI Context: ' + newContext });
      }
    }
  } catch (error) {
    log('Error: ' + error.message);
    await showToast('Error: ' + error.message);
  } finally {
    if (fs.existsSync('./ui.xml')) fs.unlinkSync('./ui.xml');
  }
}

module.exports = runAgent;