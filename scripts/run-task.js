// Windows Script Host launches Node without a console and reports its exit code to the scheduler.
var shell = new ActiveXObject('WScript.Shell');
var files = new ActiveXObject('Scripting.FileSystemObject');
var scriptsDirectory = files.GetParentFolderName(WScript.ScriptFullName);
var projectDirectory = files.GetParentFolderName(scriptsDirectory);
var nodePath = WScript.Arguments.Item(0);
var cliPath = files.BuildPath(projectDirectory, 'src\\cli.js');

shell.CurrentDirectory = projectDirectory;
var command = '"' + nodePath + '" --max-old-space-size=64 "' + cliPath + '" run --quiet --scheduled';
WScript.Quit(shell.Run(command, 0, true));
